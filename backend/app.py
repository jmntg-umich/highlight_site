import os
import sqlite3
from datetime import datetime, timezone
from flask import Flask, request, jsonify, g
from flask_cors import CORS

DB_PATH = os.path.join(os.path.dirname(__file__), "highlights.db")

from dotenv import load_dotenv
load_dotenv()

def create_app():
    app = Flask(__name__)

    allowed_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
    # If you set explicit origins, Flask-Cors will reflect only those.
    CORS(
    app,
    resources={r"/*": {"origins": allowed_origins if allowed_origins else "*"}},
    methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Admin-Token"],
)


    admin_token = os.getenv("ADMIN_TOKEN", "")

    def get_db():
        if "db" not in g:
            g.db = sqlite3.connect(DB_PATH)
            g.db.row_factory = sqlite3.Row
        return g.db

    @app.teardown_appcontext
    def close_db(exception):
        db = g.pop("db", None)
        if db is not None:
            db.close()

    def init_db():
        db = sqlite3.connect(DB_PATH)
        db.execute("""
            CREATE TABLE IF NOT EXISTS highlights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                deviceKey TEXT NOT NULL,
                start INTEGER NOT NULL,
                end INTEGER NOT NULL,
                quote TEXT NOT NULL,
                colorId TEXT NOT NULL,
                createdAt TEXT NOT NULL
            );
        """)
        db.execute("CREATE INDEX IF NOT EXISTS idx_highlights_device ON highlights(deviceKey);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_highlights_start_end ON highlights(start, end);")
        db.commit()
        db.close()

    init_db()

    def validate_highlight(payload):
        if not isinstance(payload, dict):
            return None, "Invalid JSON"
        try:
            start = int(payload.get("start"))
            end = int(payload.get("end"))
        except Exception:
            return None, "start/end must be integers"

        quote = payload.get("quote", "")
        color_id = payload.get("colorId", "")
        device_key = payload.get("deviceKey", "")
        if not isinstance(device_key, str) or len(device_key) < 8 or len(device_key) > 128:
            return None, "Invalid deviceKey"

        if start < 0 or end <= start:
            return None, "Invalid range"
        if not isinstance(quote, str) or len(quote.strip()) == 0 or len(quote) > 5000:
            return None, "Invalid quote"
        if not isinstance(color_id, str) or len(color_id) == 0 or len(color_id) > 32:
            return None, "Invalid colorId"

        return {
            "deviceKey": device_key,
            "start": start,
            "end": end,
            "quote": quote,
            "colorId": color_id
        }, None

    @app.get("/health")
    def health():
        return jsonify({"ok": True})

    @app.get("/highlights")
    def get_highlights():
        db = get_db()
        rows = db.execute(
            "SELECT start, end, quote, colorId, createdAt FROM highlights ORDER BY start ASC, end ASC"
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.post("/highlights")
    def add_highlight():
        payload = request.get_json(silent=True)
        h, err = validate_highlight(payload)
        if err:
            return jsonify({"error": err}), 400

        # Basic anti-abuse: cap table size (simple strategy).
        # For real courses, you might prefer per-day caps or IP rate limiting.
        db = get_db()
        count = db.execute("SELECT COUNT(*) AS c FROM highlights").fetchone()["c"]
        if count >= 20000:
            return jsonify({"error": "Highlight store full"}), 503

        created_at = datetime.now(timezone.utc).isoformat()
        db.execute(
            "INSERT INTO highlights(deviceKey, start, end, quote, colorId, createdAt) VALUES (?,?,?,?,?,?)",
            (h["deviceKey"], h["start"], h["end"], h["quote"], h["colorId"], created_at)        
        )
        db.commit()
        return jsonify({"ok": True, "createdAt": created_at}), 201
    
    @app.post("/highlights/erase")
    def erase():
        payload = request.get_json(silent=True) or {}
        device_key = payload.get("deviceKey", "")
        try:
            a = int(payload.get("start"))
            b = int(payload.get("end"))
        except Exception:
            return jsonify({"error": "start/end must be integers"}), 400

        if not isinstance(device_key, str) or len(device_key) < 8 or len(device_key) > 128:
            return jsonify({"error": "Invalid deviceKey"}), 400
        if a < 0 or b <= a:
            return jsonify({"error": "Invalid range"}), 400

        db = get_db()

        # Get rows for this device that overlap [a,b)
        rows = db.execute(
            """
            SELECT id, start, end, quote, colorId, createdAt
            FROM highlights
            WHERE deviceKey = ?
            AND NOT (end <= ? OR start >= ?)
            ORDER BY start ASC, end ASC
            """,
            (device_key, a, b)
        ).fetchall()

        deleted = 0
        updated = 0
        inserted = 0

        for r in rows:
            rid = r["id"]
            s = r["start"]
            e = r["end"]
            quote = r["quote"]
            colorId = r["colorId"]
            createdAt = r["createdAt"]

            # Case 1: fully covered -> delete row
            if a <= s and e <= b:
                db.execute("DELETE FROM highlights WHERE id=?", (rid,))
                deleted += 1
                continue

            # Case 2: overlap left edge -> keep right remainder [b, e)
            if a <= s and b < e:
                new_start = b
                new_end = e
                new_quote = quote[(b - s):] if isinstance(quote, str) else ""
                db.execute(
                    "UPDATE highlights SET start=?, end=?, quote=? WHERE id=?",
                    (new_start, new_end, new_quote, rid)
                )
                updated += 1
                continue

            # Case 3: overlap right edge -> keep left remainder [s, a)
            if s < a and e <= b:
                new_start = s
                new_end = a
                new_quote = quote[:(a - s)] if isinstance(quote, str) else ""
                db.execute(
                    "UPDATE highlights SET start=?, end=?, quote=? WHERE id=?",
                    (new_start, new_end, new_quote, rid)
                )
                updated += 1
                continue

            # Case 4: erase in middle -> split into [s,a) and [b,e)
            if s < a and b < e:
                left_start, left_end = s, a
                right_start, right_end = b, e

                left_quote = quote[:(a - s)] if isinstance(quote, str) else ""
                right_quote = quote[(b - s):] if isinstance(quote, str) else ""

                # Update current row to left piece
                db.execute(
                    "UPDATE highlights SET start=?, end=?, quote=? WHERE id=?",
                    (left_start, left_end, left_quote, rid)
                )
                updated += 1

                # Insert right piece as a new row (same deviceKey/color/createdAt)
                db.execute(
                    """
                    INSERT INTO highlights(deviceKey, start, end, quote, colorId, createdAt)
                    VALUES (?,?,?,?,?,?)
                    """,
                    (device_key, right_start, right_end, right_quote, colorId, createdAt)
                )
                inserted += 1
                continue

        db.commit()
        return jsonify({"ok": True, "deleted": deleted, "updated": updated, "inserted": inserted})
    
    @app.post("/highlights/delete_one_exact")
    def delete_one_exact():
        payload = request.get_json(silent=True) or {}
        try:
            start = int(payload.get("start"))
            end = int(payload.get("end"))
        except Exception:
            return jsonify({"error": "start/end must be integers"}), 400

        color_id = payload.get("colorId")
        if not isinstance(color_id, str) or not color_id:
            return jsonify({"error": "colorId required"}), 400

        if start < 0 or end <= start:
            return jsonify({"error": "Invalid range"}), 400

        db = get_db()
        row = db.execute(
            "SELECT id FROM highlights WHERE start=? AND end=? AND colorId=? ORDER BY id ASC LIMIT 1",
            (start, end, color_id)
        ).fetchone()

        if row is None:
            return jsonify({"ok": True, "deleted": 0})

        db.execute("DELETE FROM highlights WHERE id=?", (row["id"],))
        db.commit()
        return jsonify({"ok": True, "deleted": 1})

    @app.post("/admin/clear")
    def admin_clear():
        admin_token = os.getenv("ADMIN_TOKEN", "")  # read at request time
        token = request.headers.get("X-Admin-Token", "")
        if not admin_token or token != admin_token:
            return jsonify({"error": "Unauthorized"}), 401

        payload = request.get_json(silent=True) or {}
        if payload.get("confirm") is not True:
            return jsonify({"error": "Missing confirm:true"}), 400

        db = get_db()
        db.execute("DELETE FROM highlights")
        db.commit()
        return jsonify({"ok": True})
    
    @app.route("/highlights/erase", methods=["OPTIONS"])
    def erase_options():
        return ("", 204)

    return app

app = create_app()

if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    port = int(os.getenv("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=True)

    
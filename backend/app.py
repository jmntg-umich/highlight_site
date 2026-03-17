import os
import sqlite3
from datetime import datetime, timezone

from dotenv import load_dotenv
from flask import Flask, request, jsonify, g, make_response
from flask_cors import CORS

load_dotenv()

DB_PATH = os.path.join(os.path.dirname(__file__), "highlights.db")

def create_app():
    app = Flask(__name__)
    @app.get("/debug/routes")
    def debug_routes():
        return jsonify(sorted([f"{r.rule} {sorted(r.methods)}" for r in app.url_map.iter_rules()]))

    allowed_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
    CORS(
        app,
        resources={r"/*": {"origins": allowed_origins if allowed_origins else "*"}},
        methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Admin-Token"],
    )

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
        db.row_factory = sqlite3.Row

        # 1) Ensure table exists (old schema might exist already)
        db.execute("""
            CREATE TABLE IF NOT EXISTS highlights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                start INTEGER NOT NULL,
                end INTEGER NOT NULL,
                quote TEXT NOT NULL,
                colorId TEXT NOT NULL,
                createdAt TEXT NOT NULL
            );
        """)

        # 2) If deviceKey column is missing, add it
        cols = [r["name"] for r in db.execute("PRAGMA table_info(highlights);").fetchall()]
        if "deviceKey" not in cols:
            db.execute("ALTER TABLE highlights ADD COLUMN deviceKey TEXT;")
            # Existing rows (from before) will have NULL deviceKey; that's ok.

        # 3) Create indexes (safe after column exists)
        db.execute("CREATE INDEX IF NOT EXISTS idx_highlights_start_end ON highlights(start, end);")
        db.execute("CREATE INDEX IF NOT EXISTS idx_highlights_device ON highlights(deviceKey);")

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

    @app.route("/highlights/erase", methods=["POST", "OPTIONS"])
    def erase():
        if request.method == "OPTIONS":
            return make_response("", 204)

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

        deleted = updated = inserted = 0

        for r in rows:
            rid = r["id"]
            s = r["start"]
            e = r["end"]
            quote = r["quote"]
            colorId = r["colorId"]
            createdAt = r["createdAt"]

            if a <= s and e <= b:
                db.execute("DELETE FROM highlights WHERE id=?", (rid,))
                deleted += 1
                continue

            if a <= s and b < e:
                new_quote = quote[(b - s):] if isinstance(quote, str) else ""
                db.execute(
                    "UPDATE highlights SET start=?, end=?, quote=? WHERE id=?",
                    (b, e, new_quote, rid)
                )
                updated += 1
                continue

            if s < a and e <= b:
                new_quote = quote[:(a - s)] if isinstance(quote, str) else ""
                db.execute(
                    "UPDATE highlights SET start=?, end=?, quote=? WHERE id=?",
                    (s, a, new_quote, rid)
                )
                updated += 1
                continue

            if s < a and b < e:
                left_quote = quote[:(a - s)] if isinstance(quote, str) else ""
                right_quote = quote[(b - s):] if isinstance(quote, str) else ""

                db.execute(
                    "UPDATE highlights SET start=?, end=?, quote=? WHERE id=?",
                    (s, a, left_quote, rid)
                )
                updated += 1

                db.execute(
                    """
                    INSERT INTO highlights(deviceKey, start, end, quote, colorId, createdAt)
                    VALUES (?,?,?,?,?,?)
                    """,
                    (device_key, b, e, right_quote, colorId, createdAt)
                )
                inserted += 1
                continue

        db.commit()
        return jsonify({"ok": True, "deleted": deleted, "updated": updated, "inserted": inserted})

    @app.post("/admin/clear")
    def admin_clear():
        admin_token = os.getenv("ADMIN_TOKEN", "")
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

    return app


app = create_app()

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=True)
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
    CORS(app, resources={r"/*": {"origins": allowed_origins if allowed_origins else "*"}})

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
                start INTEGER NOT NULL,
                end INTEGER NOT NULL,
                quote TEXT NOT NULL,
                colorId TEXT NOT NULL,
                createdAt TEXT NOT NULL
            );
        """)
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

        if start < 0 or end <= start:
            return None, "Invalid range"
        if not isinstance(quote, str) or len(quote.strip()) == 0 or len(quote) > 5000:
            return None, "Invalid quote"
        if not isinstance(color_id, str) or len(color_id) == 0 or len(color_id) > 32:
            return None, "Invalid colorId"

        return {
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
            "INSERT INTO highlights(start, end, quote, colorId, createdAt) VALUES (?,?,?,?,?)",
            (h["start"], h["end"], h["quote"], h["colorId"], created_at)
        )
        db.commit()
        return jsonify({"ok": True, "createdAt": created_at}), 201

    @app.post("/admin/clear")
    def admin_clear():
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
    from dotenv import load_dotenv
    load_dotenv()
    port = int(os.getenv("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=True)
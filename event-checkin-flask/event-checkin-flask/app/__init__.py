from flask import Flask, render_template, jsonify
from app.config import Config
from app.db import init_pool, close_pool
from app.services.initialization import initialize_database
from app.routes.auth import bp as auth_bp
from app.routes.api import bp as api_bp

def create_app(test_config=None):
    app = Flask(__name__, template_folder="../templates", static_folder="../static")
    app.config.from_object(Config)
    if test_config:
        app.config.update(test_config)
    if not app.config["SECRET_KEY"]:
        raise RuntimeError("Imposta SECRET_KEY nel file .env.")
    if not app.config["ADMIN_PASSWORD"] or not app.config["STATION_PASSWORD"]:
        raise RuntimeError("Imposta ADMIN_PASSWORD e STATION_PASSWORD nel file .env.")
    if app.config["ADMIN_PASSWORD"] == app.config["STATION_PASSWORD"]:
        raise RuntimeError("ADMIN_PASSWORD e STATION_PASSWORD devono essere diverse.")
    init_pool(app.config["DATABASE_URL"])
    initialize_database(app.config)
    app.register_blueprint(auth_bp)
    app.register_blueprint(api_bp)

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/health")
    def health():
        return jsonify(status="ok")

    @app.teardown_appcontext
    def shutdown_session(exception=None):
        # Le connessioni vengono restituite al pool da app.db.cursor/connection.
        pass

    return app

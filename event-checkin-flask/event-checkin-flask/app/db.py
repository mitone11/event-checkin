from contextlib import contextmanager
from psycopg2.pool import ThreadedConnectionPool
from psycopg2.extras import RealDictCursor

_pool = None

def init_pool(database_url):
    global _pool
    if not database_url:
        raise RuntimeError("Imposta DATABASE_URL con la stringa di connessione PostgreSQL.")
    _pool = ThreadedConnectionPool(1, 10, dsn=database_url, connect_timeout=30)

@contextmanager
def connection():
    if _pool is None:
        raise RuntimeError("Pool PostgreSQL non inizializzato.")
    conn = _pool.getconn()
    try:
        yield conn
    finally:
        _pool.putconn(conn)

@contextmanager
def cursor(commit=False):
    with connection() as conn:
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                yield cur
            if commit:
                conn.commit()
        except Exception:
            conn.rollback()
            raise

def close_pool():
    global _pool
    if _pool:
        _pool.closeall()
        _pool = None

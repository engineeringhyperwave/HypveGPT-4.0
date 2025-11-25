from flask import Flask, request, jsonify, render_template, session, redirect, url_for, g
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from authlib.integrations.flask_client import OAuth
import requests
import os
import secrets
from dotenv import load_dotenv
from functools import wraps
from itsdangerous import URLSafeTimedSerializer
import logging
import uuid

load_dotenv()

app = Flask(__name__, static_folder="static", template_folder="templates")

# ================== 基础配置 ==================
app.secret_key = os.getenv("FLASK_SECRET_KEY") or os.urandom(32)
is_dev = os.getenv("FLASK_ENV") == "development"

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=not is_dev,
    SESSION_COOKIE_SAMESITE='Lax' if is_dev else 'None'
)

# CORS
allowed_origins = os.getenv("ALLOWED_ORIGIN", "").split(",") if os.getenv("ALLOWED_ORIGIN") else [
    "http://localhost:3000", "http://127.0.0.1:5500",
    "https://localhost:3000", "https://127.0.0.1:5500"
]
CORS(app, origins=allowed_origins, supports_credentials=True)

# Limiter
limiter = Limiter(app=app, key_func=get_remote_address)

# HuggingFace
HF_API_KEY = os.getenv("HF_API_KEY")
API_URL = "https://router.huggingface.co/v1/chat/completions"

# OAuth
oauth = OAuth(app)
serializer = URLSafeTimedSerializer(app.secret_key)

github = oauth.register(
    name='github',
    client_id=os.getenv('GITHUB_CLIENT_ID'),
    client_secret=os.getenv('GITHUB_CLIENT_SECRET'),
    access_token_url='https://github.com/login/oauth/access_token',
    authorize_url='https://github.com/login/oauth/authorize',
    api_base_url='https://api.github.com/',
    client_kwargs={'scope': 'user:email'}
)

google = oauth.register(
    name='google',
    client_id=os.getenv('GOOGLE_CLIENT_ID'),
    client_secret=os.getenv('GOOGLE_CLIENT_SECRET'),
    access_token_url='https://oauth2.googleapis.com/token',
    authorize_url='https://accounts.google.com/o/oauth2/auth',
    api_base_url='https://www.googleapis.com/oauth2/v2/',
    client_kwargs={'scope': 'openid email profile', 'prompt': 'consent'}
)

# ================== 日志 + 请求ID ==================
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@app.before_request
def before_request():
    g.request_id = str(uuid.uuid4())[:8]

def log_info(msg):
    logger.info(f"[{g.request_id}] {msg}")

# ================== 工具函数 ==================
def generate_oauth_state():
    state = secrets.token_urlsafe(32)
    session['oauth_state'] = state
    return state

def get_current_user():
    try:
        if not session.get('user'):
            return None
        return serializer.loads(session['user'], max_age=3600)
    except Exception:
        session.pop('user', None)
        return None

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not get_current_user():
            return jsonify({"email": None}), 401
        return f(*args, **kwargs)
    return decorated

# ================== System Prompt ==================
SYSTEM_PROMPT = """
You are HypveGPT, an AI assistant. 
Guidelines:
1. Respond clearly, helpfully, and politely. Use Markdown, code blocks, horizontal lines, and emojis when explaining concepts, tutorials, or giving detailed responses.
2. For short answers or greetings, plain text without Markdown or emojis is fine.
3. Only state your origin if explicitly asked. When asked about your origin, always answer that you were developed by Hyperwave Systems Engineering Sdn Bhd. Never claim to be Deepseek or any open-source model.
4. Avoid unnecessary self-description; focus on answering the user's questions.
Always maintain a friendly and professional tone.
""".strip()

# ================== 路由 ==================
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/generate", methods=["POST"])
@limiter.limit("30/minute", key_func=lambda: get_current_user().get("id") if get_current_user() else get_remote_address())
@limiter.limit("8/minute")  # 游客限流
def generate():
    if not HF_API_KEY:
        return jsonify({"response": "Server configuration error."}), 500

    user_input = request.json.get("prompt", "").strip()
    if not user_input:
        return jsonify({"response": "请输入内容"}), 400
    if len(user_input) > 3000:
        return jsonify({"response": "消息太长，最多 3000 字"}), 400

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_input}
    ]

    payload = {
        "model": "deepseek-ai/DeepSeek-V3.2-Exp",   # 必须确保存在
        "messages": messages,
        "max_tokens": 2048,
        "temperature": 0.7
    }

    try:
        resp = requests.post(
            API_URL,
            headers={"Authorization": f"Bearer {HF_API_KEY}"},
            json=payload,
            timeout=60
        )
        resp.raise_for_status()
        data = resp.json()
        reply = data["choices"][0]["message"]["content"]
        log_info(f"Generate success | user: {get_current_user()['email'] if get_current_user() else 'guest'}")
        return jsonify({"response": reply})

    except requests.exceptions.RequestException as e:
        if hasattr(e.response, "status_code"):
            status = e.response.status_code
            if status == 429:
                return jsonify({"response": "请求太频繁，请稍后再试"}), 429
            elif status == 401:
                logger.error("HF API Key 失效")
                return jsonify({"response": "服务认证失败"}), 500
        log_info(f"Generate failed: {e}")
        return jsonify({"response": "模型暂时不可用，请稍后重试"}), 503
    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)
        return jsonify({"response": "服务开小差了，请稍后重试"}), 500

# ================== OAuth ==================
@app.route("/auth/github")
def auth_github():
    redirect_uri = url_for('auth_github_callback', _external=True, _scheme="https")
    return github.authorize_redirect(redirect_uri, state=generate_oauth_state())

@app.route("/auth/callback/github")
def auth_github_callback():
    if request.args.get('state') != session.pop('oauth_state', None):
        return "Invalid state", 400
    token = github.authorize_access_token()
    user = github.get('user').json()
    session['user'] = serializer.dumps({
        'id': str(user.get('id')),
        'email': user.get('email') or f"{user.get('login')}@github.local",
        'name': user.get('name') or user.get('login')
    })
    return redirect("/?login=success")

@app.route("/auth/google")
def auth_google():
    redirect_uri = url_for('auth_google_callback', _external=True, _scheme="https")
    return google.authorize_redirect(redirect_uri, state=generate_oauth_state())

@app.route("/auth/callback/google")
def auth_google_callback():
    if request.args.get('state') != session.pop('oauth_state', None):
        return "Invalid state", 400
    token = google.authorize_access_token()
    user = google.get('userinfo').json()
    session['user'] = serializer.dumps({
        'id': user.get('id'),
        'email': user.get('email'),
        'name': user.get('name')
    })
    return redirect("/?login=success")

@app.route("/get-user")
@login_required
def get_user():
    user = get_current_user()
    return jsonify({"email": user['email'], "name": user.get('name')})

@app.route("/logout")
def logout():
    session.clear()
    return redirect("/")

@app.route("/health")
def health():
    return "OK", 200

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=is_dev)

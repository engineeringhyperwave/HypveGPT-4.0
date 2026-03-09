from flask import Flask, request, jsonify, render_template, session, redirect, url_for
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

# Load .env (for local development)
load_dotenv()

app = Flask(__name__, static_folder="static", template_folder="templates")

# ====== Security Config ======
app.secret_key = os.getenv("FLASK_SECRET_KEY") or os.urandom(32)

# Dynamic SameSite + Secure
is_dev = os.getenv("FLASK_ENV") == "development"
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=not is_dev,
    SESSION_COOKIE_SAMESITE='Lax' if is_dev else 'None'
)

# CORS Whitelist
allowed_origins = [
    "https://hypvegpt.onrender.com",  # Render 自己的前端
    "https://engineeringhyperwave.github.io",  # GitHub Pages
    "https://engineeringhyperwave.github.io/HypveGPT-4.0"  # 子路径
]

CORS(app, origins=allowed_origins, supports_credentials=True)

# Rate limiting
limiter = Limiter(app=app, key_func=get_remote_address)

# Hugging Face
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

# ====== Helper Functions ======
def generate_oauth_state():
    state = secrets.token_urlsafe(32)
    session['oauth_state'] = state
    return state

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('user'):
            return jsonify({"email": None}), 401
        return f(*args, **kwargs)
    return decorated

# ====== Routes ======
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/generate", methods=["POST"])
@limiter.limit("15/minute")
def generate():
    if not HF_API_KEY:
        return jsonify({"response": "Server configuration error."}), 500

    user_input = request.json.get("prompt", "").strip()
    if not user_input or len(user_input) > 2000:
        return jsonify({"response": "Input is empty or too long."}), 400

    messages = [
    {"role": "system", "content": (
        "You are HypveGPT, a helpful AI assistant. "
        "Always format your response in Markdown, include sections, code blocks when appropriate, "
        "use emojis to make the response friendly, and separate each section with horizontal lines."
    )},
    {"role": "user", "content": user_input}
]
    headers = {"Authorization": f"Bearer {HF_API_KEY}"}
    payload = {
        "model": "deepseek-ai/DeepSeek-V3.2-Exp",
        "messages": messages,
        "max_tokens": 1024,
        "temperature": 0.7
    }

    try:
        response = requests.post(API_URL, headers=headers, json=payload, timeout=30)
        response.raise_for_status()
        data = response.json()
        reply = data["choices"][0]["message"]["content"]
        return jsonify({"response": reply})
    except requests.exceptions.HTTPError as e:
        if response.status_code == 429:
            return jsonify({"response": "Too many requests. Please try again later."}), 429
        elif response.status_code == 401:
            return jsonify({"response": "Authentication failed. Please contact admin."}), 401
        print("HF API HTTP Error:", str(e))
        return jsonify({"response": "Model service is temporarily unavailable."}), 500
    except requests.exceptions.Timeout:
        print("HF API Timeout")
        return jsonify({"response": "Request timed out. Please try again."}), 504
    except Exception as e:
        print("HF API Error:", e)
        return jsonify({"response": "Model service is temporarily unavailable."}), 500

# ====== OAuth Login (CSRF Protection) ======
@app.route("/auth/github")
def auth_github():
    redirect_uri = url_for('auth_github_callback', _external=True)
    return github.authorize_redirect(redirect_uri, state=generate_oauth_state())

@app.route("/auth/callback/github")
def auth_github_callback():
    if request.args.get('state') != session.pop('oauth_state', None):
        return "Invalid state", 400
    token = github.authorize_access_token()
    user = github.get('user').json()
    session['user'] = serializer.dumps({'id': user.get('id'), 'email': user.get('email'), 'name': user.get('name')})
    return redirect("/?login=success")

@app.route("/auth/google")
def auth_google():
    redirect_uri = url_for('auth_google_callback', _external=True)
    return google.authorize_redirect(redirect_uri, state=generate_oauth_state())

@app.route("/auth/callback/google")
def auth_google_callback():
    if request.args.get('state') != session.pop('oauth_state', None):
        return "Invalid state", 400
    token = google.authorize_access_token()
    user = google.get('userinfo').json()
    session['user'] = serializer.dumps({'id': user.get('id'), 'email': user.get('email'), 'name': user.get('name')})
    return redirect("/?login=success")

@app.route("/get-user")
@login_required
def get_user():
    try:
        user_data = serializer.loads(session['user'], max_age=3600)
        return jsonify({"email": user_data['email'], "name": user_data.get('name')})
    except:
        session.pop('user', None)
        return jsonify({"email": None}), 401

@app.route("/logout")
def logout():
    session.clear()
    return redirect("/")

@app.route("/health")
def health():
    return "OK", 200

# ====== Startup ======
if __name__ == "__main__":
    debug_mode = os.getenv("FLASK_ENV") == "development"
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 5000)), debug=debug_mode)
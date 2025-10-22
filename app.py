from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import requests
import os

# 初始化 Flask 应用，指定静态文件和模板文件夹
app = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app)

# Hugging Face API 设置
API_URL = "https://router.huggingface.co/v1/chat/completions"
HF_API_KEY = os.environ.get("HF_API_KEY")


# 首页路由，渲染 index.html
@app.route("/")
def index():
    return render_template("index.html")

# 接收前端请求并调用 Hugging Face 模型
@app.route("/generate", methods=["POST"])
def generate():
    user_input = request.json.get("prompt")
    if not user_input:
        return jsonify({"response": "请输入有效的问题。"})

    messages = [
        {
            "role": "system",
            "content": "你是hypvegpt"
        },
        {
            "role": "user",
            "content": user_input
        }
    ]

    headers = {
        "Authorization": f"Bearer {HF_API_KEY}"
    }

    payload = {
        "model": "deepseek-ai/DeepSeek-V3.2-Exp",
        "messages": messages
    }

    try:
        response = requests.post(API_URL, headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
        reply = data["choices"][0]["message"]["content"]
        return jsonify({"response": reply})
    except Exception as e:
        print("调用失败:", e)
        return jsonify({"response": "❌ 模型服务暂时不可用，请稍后再试。"})

# 启动 Flask 应用（兼容本地和 Render）
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)

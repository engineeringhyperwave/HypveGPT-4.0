# 使用轻量级 Python 镜像
FROM python:3.9-slim

# 设置工作目录
WORKDIR /app

# 安装依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制项目代码
COPY . .

# 设置权限（Hugging Face 运行环境要求）
RUN chmod -R 777 /app

# 暴露端口
EXPOSE 7860

# 使用 Gunicorn 启动（生产环境更稳定）
CMD ["gunicorn", "--bind", "0.0.0.0:7860", "app:app"]
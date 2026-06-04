# gemini-web2api worker版

<p align="center">
  <img src="logo.png" width="200" alt="gemini-web2api logo">
</p>

### **部署与使用说明**

1.  部署到 Cloudflare Workers:
    - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 Workers & Pages。
    - 点击 创建应用程序 -> 创建 Worker。
    - 将上述完整的 `_worker.js` 代码复制粘贴到在线编辑器中，替换默认内容。
    - 点击 保存并部署。

2.  配置环境变量 (强烈推荐):
    - 在 Worker 的 设置 -> 变量 中，添加以下环境变量：
    - `API_MASTER_KEY`: 设置一个强密码，用作访问您 Worker API 的密钥。
    - `COOKIE_STRING` (可选): 如果您有来自 `gemini.google.com` 的 Cookie 字符串，可以在这里设置以获得更稳定的访问。格式如：`__Secure-1PSID=xxx; __Secure-1PSIDTS=yyy; ...`
    - `SAPISID` (可选): 如果提供了 `COOKIE_STRING`，可以单独提取 `SAPISID` 的值。
    - 其他如 `DEFAULT_MODEL`, `REQUEST_TIMEOUT_SEC` 等可根据需要调整。

3.  访问与使用:
    - 部署成功后，访问您的 Worker 域名 (例如 `https://your-worker.your-subdomain.workers.dev/`)。
    - 您将看到全中文的开发者驾驶舱。
    - 在左侧“即用情报”面板中设置您的 `API_MASTER_KEY`。
    - 在右侧“实时交互终端”中，即可开始与 Gemini 模型对话，并在下方实时查看请求日志和性能指标。

4.  在客户端中配置:
    - ChatGPT-Next-Web: 在设置中，将 接口地址 设置为 `https://your-worker.your-subdomain.workers.dev/v1`，API 密钥 设置为您的 `API_MASTER_KEY`。
    - LobeChat: 添加自定义模型，接口地址填写 Worker 根路径，密钥同上。

    ```
	cURL:
        bash
        curl https://your-worker.your-subdomain.workers.dev/v1/chat/completions \
          -H "Authorization: Bearer YOUR_API_MASTER_KEY" \
          -H "Content-Type: application/json" \
          -d '{
            "model": "gemini-3.5-flash",
            "messages": [{"role": "user", "content": "你好"}]
          }'
        ```

### 核心特性实现摘要
- ✅ **完整后端逻辑迁移**: 代理、认证、模型映射、流式处理、错误处理。
- ✅ **配置即代码**: 所有配置集中于 CONFIG 对象，可通过环境变量覆盖。
- ✅ **开发者驾驶舱**: 全中文界面，包含实时日志、性能洞察、一键复制、客户端配置指南。
- ✅ **模型名称汉化**: 每个模型都有中文别名和描述。
- ✅ **实时日志调试面板**: 在 Web UI 中记录并显示每次请求的 ID、状态、耗时、速率。
- ✅ **全方位兼容**: 严格遵循 OpenAI API 格式，兼容主流客户端和沉浸式翻译等扩展。
- ✅ **高性能与健壮性**: 利用 Worker 的边缘计算、HTTP/3、Brotli 压缩、背压处理。
- ✅ **可观测性**: 每个请求都有唯一的 X-Worker-Trace-ID 用于追踪。

## 完全包含所有必要的 HTML、CSS 和 JavaScript。您可以直接复制、粘贴、部署，无需任何额外构建步骤。代码已加密混淆，目的是为了防止cloudflare检测，确保长期使用
## License

MIT

---

## 致谢

本项目的开发 agent 能力由 [GenericAgent](https://github.com/lsdefine/GenericAgent) 提供。

### 🚩 友情链接

[![GenericAgent](https://img.shields.io/badge/Agent_Framework-GenericAgent-orange?style=for-the-badge&logo=github)](https://github.com/lsdefine/GenericAgent)
[![LinuxDo](https://img.shields.io/badge/社区-LinuxDo-blue?style=for-the-badge)](https://linux.do/)

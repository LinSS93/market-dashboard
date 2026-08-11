# Public screenshot policy / 公开截图规范

Use this directory only for images that are safe to publish. Screenshots are optional; documentation must remain understandable without them.
此目录仅可存放适合公开发布的图片。截图是可选项；即使没有截图，文档也必须能够独立说明使用方法。

- Use fabricated demo data or material with explicit redistribution permission. / 只使用虚构演示数据，或获得明确再分发授权的材料。
- Do not show holdings, account identifiers, personal names, local paths, API keys, cookies, internal IP addresses, provider payloads, or production timestamps. / 不得展示持仓、账户标识、个人姓名、本地路径、API 密钥、Cookie、内网地址、数据源原始响应或生产时间戳。
- Crop browser chrome and remove notifications before capture. / 截图前裁掉浏览器边框并清除通知。
- Add a short caption that says the image uses demo data. / 为每张图片添加“使用演示数据”的简短说明。
- Run `npm run verify:public:strict` after adding an image. / 添加图片后运行 `npm run verify:public:strict`。

# my-tiny-claw 实战工作区

## 架构规范
- 使用 TypeScript 和 Node.js 标准库，不引入额外依赖。
- HTTP 接口必须返回 JSON 格式，并包含 `code` 和 `message` 字段。
- `GET /ping` 返回 HTTP 200，响应为 `{"code":200,"message":"pong"}`。
- 错误响应中的 message 必须使用中文，未匹配的路由返回 HTTP 404。
- 默认监听 `127.0.0.1:8080`。

## 工作区纪律
- 不允许删除工作区根目录的文件，不修改或提交父目录的主项目。
- 修改已有文件前先读取，只提交本次任务相关文件。
- 完成后说明启动和验证方法，不遗留持续运行的服务。
- 可以从主项目根目录执行 `node --import tsx workspace/ping.ts` 启动服务。

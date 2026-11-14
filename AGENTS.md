# shelfmark

自托管书签服务：Go 单程序（Floccus 用的 WebDAV + REST API + 网页/PWA），配一个浏览器插件。

- 设计看 `docs/design.md`，接口契约是 `api/openapi.yaml`。改接口先改契约，再改实现。
- 目录：`server/` Go 服务端，`web/` 网页，`extension/` 插件，`e2e/` 端到端测试。
- 代码、配置、示例里不写账号、密码、Token、私有地址和真实主机名；示例用 `example.com`、`alice`。
- 提交信息不加任何 AI 署名（不写 Co-Authored-By 之类）。
- worktree 放 `.worktrees/<名>`。
- 测试：`cd server && go test ./...`；`cd web && npm test`；`cd extension && npm test`；端到端见 `e2e/README.md`。
- 测试里不调用真实的大模型接口，AI 相关一律用假服务。

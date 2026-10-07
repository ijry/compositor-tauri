# 插件自动发布 CI

工作流：`.github/workflows/release-plugin.yml`。构建和发布分离，支持 dry-run、手动发布与 v* 标签触发。

## 当前仓库配置

- GitHub Environment：`release`。
- Environment Secret：`XYCLOUD_PAT`（加密保存，不是普通 Variable，不进入源码或产物）。
- Environment Variable：`XYCLOUD_AUTH_MODE=pat`。
- Repository Variable：`OTOOLS_PUBLISH_MARKET=true`，未来推送版本标签时自动同步市场。
- 市场地址可通过 `release` 环境的 `OTOOLS_MARKET_API` 覆盖。

PAT 明文只通过标准输入传入 GitHub CLI，不写入命令参数或日志。更换 PAT 时更新同名 Secret 即可，不需要修改工作流。

## 建议先运行一次验证

在 Actions 中运行 `release-plugin`，选择 `auth_mode=pat`、`publish_market=true`、`dry_run=true`。

这会构建、测试、打包、上传 artifact，并验证发布产物、GitHub 标签归属和环境 Secret 的格式。**不会创建标签、GitHub Release，也不会请求插件市场或把 PAT 发往平台。**因此验证成功不等于平台已接受 PAT 的权限或已经上架。

```bash
gh workflow run release-plugin.yml --ref main -f auth_mode=pat -f publish_market=true -f dry_run=true
```

真正发布时再关闭 dry_run，或推送与 plugin.json 版本一致的 `v<version>` 标签。

## 四种认证（显式选择，不自动降级）

| auth_mode | 凭证配置 | 发布身份 |
| --- | --- | --- |
| pat | Secret `XYCLOUD_PAT` | 个人 PAT 所属用户，按权限和可选资源限制校验 |
| oidc | 下述 OIDC Variables | 可信发布绑定所属用户，按权限和可选资源限制校验 |
| login | Secret `XYCLOUD_LOGIN_TOKEN` | 原用户登录 Bearer Token；该模式保留 |
| shared | Secret `OTOOLS_MARKET_TOKEN` | 原官方/内置插件发布密钥；保留，不废弃 |

login 值可填写登录 token 或完整 Bearer 前缀。用户不应获取官方共享密钥。PAT 或 OIDC 验证失败会使发布步骤失败，不会退回官方身份。

## 普通开发者：先用 PAT

1. PC 个人中心 → 访问令牌，默认选择全部当前可授予权限（目前只有插件发布）。
2. 插件范围默认覆盖本人所有插件，允许首次创建自己的插件；需要收窄时再选指定插件。
3. 将一次性明文保存到 `release` Environment Secret `XYCLOUD_PAT`。
4. 手动运行 Actions，选择 pat，勾选 publish_market，关闭 dry_run。

以后新增权限时，可在 PC 访问令牌列表中编辑原 PAT，勾选“编辑权限和资源范围”后授权。**编辑不更换密钥，GitHub Secret `XYCLOUD_PAT` 不用修改**；只改名称不刷新原权限快照。授权编辑后已兑换的短期令牌失效，重新兑换即可。“重置”才会轮换密钥并需要同步更新 Secret。

## GitHub OIDC 可信发布

先在平台 PC 个人中心 → GitHub 可信发布创建绑定，通过 GitHub OAuth 验证目标仓库管理权限。权限与 PAT 使用同一机制：全部当前权限或指定权限，插件范围可以不限制为单个插件。

本插件示例绑定：

| 项目 | 值 |
| --- | --- |
| 权限 | 包含 `otools:plugin:publish`（也可选全部当前权限） |
| 资源范围 | 默认本人所有插件（含首次创建），或指定自己的 `otools-compositor` |
| GitHub 仓库 | `ijry/compositor-tauri`，fork 时填写自己的仓库 |
| 工作流 | `.github/workflows/release-plugin.yml` |
| 引用规则 | `refs/tags/v*`，或手动发布所用的精确分支，如 `refs/heads/main` |
| Environment | `release`（本工作流使用该环境，建议设置保护审批规则） |

为 `release` Environment 配置 Variables（也可使用 Repository Variables）：

- `XYCLOUD_OIDC_ISSUER`：`https://实际接口域名/api/v1/user_pat/workload/token`，不是 GitHub issuer，也不是个人密钥。
- `XYCLOUD_OIDC_AUDIENCE`：`otools-ci`，须与服务端一致。
- `XYCLOUD_PUBLISHER_ID`：在平台验证仓库后生成的绑定 ID，可公开，不是秘密。
- `OTOOLS_MARKET_API`：市场发布接口，默认 `https://otools-api.lingyun.net/api/v1/otools/plugin/publish`。

CI 在同一发布进程中获取 GitHub 响应的 value，将 JWT 发给兑换接口，读取 xycloud 响应的 data.access_token，然后立即发布。凭证不经过 job outputs 或 artifact，日志仅显示脱敏标记。

市场授权与 GitHub 写权限独立。创建本仓库 Release 使用 GitHub 自动生成的 GITHUB_TOKEN，不从 xycloud 兑换所谓 git_token。

## 标签自动发布

- 更新 plugin.json 版本号后推送一致的 `v<version>` 标签。
- 配置 Variable `OTOOLS_PUBLISH_MARKET=true` 才自动同步市场；未启用时仅发布 GitHub Release。
- 配置 Variable `XYCLOUD_AUTH_MODE` 为 pat/oidc/login/shared，默认 pat，并配齐相应凭证或绑定。
- 发布 job 使用 Environment `release`，若设置审批需通过审批。
- 推送分支不会触发发布。配置工作流文件不代表已经执行过真实发布。

## 打包与发布资源

使用 Node 22 构建（打包脚本使用 node:zlib 的 crc32）。

```sh
pnpm install --frozen-lockfile
pnpm exec vue-tsc -p tsconfig.app.json --noEmit --pretty false
node --test scripts/*.test.mjs
pnpm build
node scripts/pack-plugin.mjs --out dist-pack
python scripts/verify-plugin.py dist-pack
```

.oplg 是 ZIP，内含 plugin.json、logo.svg、dist（以及存在时的 lib）。正式清单去除 devUrl/quickDev，不修改开发用的源 plugin.json。

构建产物为扁平目录：`.oplg`、`plugin.json`、`logo.svg`、`SHA256SUMS`。打包和发布前都会验证 SHA-256、ZIP CRC、入口文件、包内外清单与图标的一致性。Release 上传这四类文件，市场使用实际 packageUrl 和 logo 地址。

发布前检查当前标签对应的提交，拒绝用同版本覆盖其他提交的产物。相同提交可重试上传；认证配置检查先于 GitHub Release 创建。PAT、OIDC、登录和共享密钥仍显式选择，不自动降级。

HTTP 失败、业务 code 非 200、缺失凭证、版本/tag 不一致都会明确失败。

## 服务端上线前

更新 xystack 后对 user_pat 执行 SQL 更新，增加 PAT 范围/revision 及可信发布绑定表。通用 PAT 增加 scopeMode/resources，PAT 与 OIDC 新增权限均由服务端注册处理器；默认全部权限在授权时展开为快照，不自动取得未来权限。原登录态及官方共享密钥继续使用。

OIDC 还需要平台管理员配置 GitHub OAuth Client ID/Secret 和固定 PC HTTPS 回调 URL。用户绑定的仓库、工作流、ref、环境与过期时间都要匹配，不能只把仓库加入全局白名单。

本地测试覆盖四种认证流程、JSON 提取、错误响应、dry-run 写操作开关、打包清单与篡改检测、标签提交归属。平台真实发布仍需正式运行后确认。


## 2026-10-07 接入验证记录

- [x] release 环境的 XYCLOUD_PAT 加密 Secret 已配置；普通 Variables 不保存 PAT。
- [x] PAT 模式、市场地址与未来版本标签自动同步市场的开关已配置。
- [x] 14 项本地脚本测试、完整构建、包摘要/CRC/入口/清单验证通过。
- [x] 改动文件及包内容完成真实 PAT 明文检查，未发现泄漏。
- [x] GitHub Actions dry-run 完整通过：[运行 37564303698](https://github.com/ijry/compositor-tauri/actions/runs/37564303698)，验证代码提交 0884b597b3cf05f37628800d1c9e5df3d0264fdb。
- [x] 下载 Actions 的 oplg artifact 后再次通过独立包验证。

该次运行明确跳过 GitHub Release 创建和市场提交。仅验证 Secret 的存在及格式，没有向市场发送 PAT；真实令牌权限、有效期和上架结果仍需正式发布确认。

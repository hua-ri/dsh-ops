# @hua-ri/dsh-ops

DSH 一体化运维插件 — 在 DeepSeek Harness 中管理 SSH 主机、Kubernetes 集群、Helm Chart、ArgoCD 和 Argo Workflows。

## 功能

- **SSH 远程运维** — 主机管理、命令执行、文件浏览、隧道、密钥管理、命令片段、批量操作
- **Kubernetes 集群管理** — 多集群上下文、资源浏览（get/describe/logs/exec）、apply/delete/scale/rollout
- **Helm Chart 管理** — Release 管理、仓库 CRUD、Chart 搜索与详情、安装/升级/卸载
- **ArgoCD 部署管理** — 应用列表与状态、同步、回滚、日志
- **Argo Workflows** — 工作流列表、提交、重试、日志

共 49 个 DSH Tools，AI agent 可直接调用所有运维能力。

## 安装

```bash
pnpm add @hua-ri/dsh-ops
```

在 DSH profile 的 `package.json` 中添加依赖，并在 bundles 中启用：

```json
{
  "dependencies": {
    "@hua-ri/dsh-ops": "^0.2.0"
  },
  "dsh": {
    "bundles": ["@hua-ri/dsh-ops"]
  }
}
```

## 系统依赖

| CLI 工具 | 模块 | 安装方式 |
|----------|------|----------|
| ssh | SSH（必需） | macOS 自带 |
| kubectl | K8s（必需） | `brew install kubectl` |
| helm | Helm | `brew install helm` |
| argocd | ArgoCD | `brew install argocd` |
| argo | Argo Workflows | `brew install argo` |

运行 `node scripts/doctor.mjs` 检查依赖状态。

## 配置

插件安装后各模块可独立启停（SSH 和 K8s 默认启用）：

```json
{
  "ssh": { "enabled": true },
  "k8s": { "enabled": true },
  "argocd": { "enabled": false },
  "argowf": { "enabled": false }
}
```

## License

MIT

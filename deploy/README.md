# avifeed 部署文档

## 构建项目

```bash
pnpm install
pnpm build
```

## 注册 systemd 服务

```bash
sudo cp deploy/avifeed.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now avifeed
```

## 验证

```bash
systemctl status avifeed
journalctl -u avifeed -f
```

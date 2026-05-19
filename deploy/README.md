# Deploy

## systemd

1. Build on the target host (or copy `dist/` + `node_modules/` + `package.json` + `config.json`):
   ```sh
   npm ci --omit=dev
   npm run build
   ```
2. Place files under `/opt/avifeed` (or edit `WorkingDirectory` in the unit file).
3. Create a dedicated user:
   ```sh
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin avifeed
   sudo chown -R avifeed:avifeed /opt/avifeed
   ```
4. Install the unit:
   ```sh
   sudo cp deploy/avifeed.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now avifeed
   ```
5. Check status / logs:
   ```sh
   systemctl status avifeed
   journalctl -u avifeed -f
   ```

`config.json` is read from `WorkingDirectory` by default; override with `RIS_CONFIG=/etc/avifeed/config.json` in the unit file.

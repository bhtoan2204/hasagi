# Timesheet App

## Chạy bằng Docker

```bash
docker compose up -d --build
```

Mở:

```text
http://20.195.43.228
```

Kiểm tra:

```bash
curl http://127.0.0.1/health
```

Xem log:

```bash
docker compose logs -f
```

Dừng:

```bash
docker compose down
```

## Firewall

Ubuntu UFW:

```bash
sudo ufw allow 80/tcp
```

Azure NSG cần có inbound rule:

- Protocol: TCP
- Destination port: 80
- Source: IP của bạn hoặc Internet tùy nhu cầu
- Action: Allow

## Đổi thông tin nhân viên

Sửa các biến trong `docker-compose.yml`:

- `LOCATION_ID`
- `DEPARTMENT_ID`
- `STAFF_CODE`

Sau đó chạy lại:

```bash
docker compose up -d --build
```

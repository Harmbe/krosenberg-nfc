#!/bin/bash
# Krösenberg printserver — installatiescript voor Raspberry Pi
# Uitvoeren: bash install.sh

set -e
echo "=== Krösenberg printserver installeren ==="

# 1. Systeem bijwerken en afhankelijkheden installeren
sudo apt-get update -q
sudo apt-get install -y python3-pip python3-venv libcups2-dev

# 2. Virtuele omgeving aanmaken
cd "$(dirname "$0")"
python3 -m venv venv
source venv/bin/activate
pip install -q -r requirements.txt

# 3. Printerrechten instellen (gebruiker toevoegen aan lp-groep)
sudo usermod -aG lp "$USER"
echo "Printerrechten ingesteld voor gebruiker: $USER"

# 4. Systemd-service aanmaken zodat de server automatisch start
SERVICE_FILE=/etc/systemd/system/krosenberg-print.service
WORK_DIR="$(pwd)"

sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Krösenberg Printserver
After=network.target

[Service]
ExecStart=$WORK_DIR/venv/bin/python $WORK_DIR/server.py
WorkingDirectory=$WORK_DIR
Restart=always
User=$USER
Environment=PRINTER_DEV=/dev/usb/lp0

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable krosenberg-print
sudo systemctl start krosenberg-print

echo ""
echo "=== Installatie klaar ==="
echo ""
echo "Printserver draait op: http://$(hostname -I | awk '{print $1}'):5000"
echo ""
echo "Controleer status:  sudo systemctl status krosenberg-print"
echo "Logs bekijken:      sudo journalctl -u krosenberg-print -f"
echo ""
echo "Vul dit IP-adres in bij Beheer > Printer instellen in de tablet-app."
echo ""
echo "LET OP: log opnieuw in (of herstart) zodat printerrechten actief worden."

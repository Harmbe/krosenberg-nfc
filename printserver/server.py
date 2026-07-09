#!/usr/bin/env python3
"""
Krösenberg printserver — draait op Raspberry Pi
Ontvangt bonnen van de tablet-app en stuurt ze naar de thermische USB-printer.
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import escpos.printer as escpos
import datetime, os, sys

app = Flask(__name__)
CORS(app)  # staat verzoeken toe vanuit de tablet-browser

# USB-printerpad — pas aan als de Pi een ander pad toont (zie README)
PRINTER_DEV = os.environ.get('PRINTER_DEV', '/dev/usb/lp0')

def get_printer():
    return escpos.File(PRINTER_DEV)

def print_bon(p, data):
    naam     = data.get('naam', '?')
    plek     = data.get('plek', '?')
    items    = data.get('items', [])   # [[naam, {prijs, aantal}], ...]
    totaal   = data.get('totaal', 0)
    tijdstip = datetime.datetime.now().strftime('%d-%m-%Y  %H:%M')

    p.set(align='center', bold=True, width=2, height=2)
    p.text('KRÖSENBERG\n')
    p.set(align='center', bold=False, width=1, height=1)
    p.text('Kampeervereniging\n')
    p.text('─' * 32 + '\n')

    p.set(align='left')
    p.text(f'Gast : {naam}\n')
    p.text(f'Plek : {plek}\n')
    p.text(f'Tijd : {tijdstip}\n')
    p.text('─' * 32 + '\n')

    for item in items:
        # item = [naam, {prijs, aantal}]  of  {naam, prijs, aantal}
        if isinstance(item, list):
            inaam, v = item[0], item[1]
            aantal, prijs = v.get('aantal', 1), v.get('prijs', 0)
        else:
            inaam, aantal, prijs = item.get('naam'), item.get('aantal', 1), item.get('prijs', 0)
        regel = f'{aantal}x {inaam}'
        bedrag = f'€{aantal * prijs:.2f}'.replace('.', ',')
        # Rechts uitlijnen op 32 tekens
        spaties = 32 - len(regel) - len(bedrag)
        p.text(regel + ' ' * max(1, spaties) + bedrag + '\n')

    p.text('─' * 32 + '\n')
    p.set(bold=True)
    totaal_str = f'€{totaal:.2f}'.replace('.', ',')
    label = 'TOTAAL'
    p.text(label + ' ' * (32 - len(label) - len(totaal_str)) + totaal_str + '\n')
    p.set(bold=False)
    p.text('\n\n')
    p.cut()

@app.route('/print', methods=['POST'])
def print_route():
    data = request.get_json(force=True)
    if not data:
        return jsonify({'ok': False, 'fout': 'Geen data ontvangen'}), 400
    try:
        p = get_printer()
        print_bon(p, data)
        return jsonify({'ok': True})
    except FileNotFoundError:
        return jsonify({'ok': False, 'fout': f'Printer niet gevonden op {PRINTER_DEV}'}), 503
    except Exception as e:
        return jsonify({'ok': False, 'fout': str(e)}), 500

@app.route('/testprint', methods=['POST'])
def testprint():
    try:
        p = get_printer()
        p.set(align='center', bold=True, width=2, height=2)
        p.text('KRÖSENBERG\n')
        p.set(align='center', bold=False, width=1, height=1)
        p.text('Printer werkt!\n')
        p.text(datetime.datetime.now().strftime('%d-%m-%Y %H:%M') + '\n')
        p.text('\n\n')
        p.cut()
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'ok': False, 'fout': str(e)}), 500

@app.route('/status', methods=['GET'])
def status():
    printer_ok = os.path.exists(PRINTER_DEV)
    return jsonify({'ok': printer_ok, 'printer': PRINTER_DEV})

if __name__ == '__main__':
    print(f'Printserver gestart — printer: {PRINTER_DEV}')
    app.run(host='0.0.0.0', port=5000)

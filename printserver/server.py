#!/usr/bin/env python3
"""
Krösenberg printserver — draait op Raspberry Pi
Ontvangt bonnen van de tablet-app en stuurt ze naar de thermische USB-printer.
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import escpos.printer as escpos
import datetime, hmac, os, sys

app = Flask(__name__)

# Herkomst waarvandaan de tablet-app (Fully Kiosk) verzoeken mag sturen. Staat
# standaard nog open (*) zodat een bestaande installatie na deze update blijft
# werken — de sleutel hieronder is de eigenlijke toegangscontrole. Zet
# PRINTSERVER_ALLOWED_ORIGIN op de domeinnaam van de kassa-app voor extra
# verharding.
ALLOWED_ORIGIN = os.environ.get('PRINTSERVER_ALLOWED_ORIGIN', '*')
CORS(app, origins=[ALLOWED_ORIGIN])

# Gedeelde sleutel tussen tablet-app en printserver. Zonder deze sleutel kan
# elk apparaat op hetzelfde wifi-netwerk bonnen laten printen of de
# printerstatus opvragen — de server start daarom bewust niet zonder.
PRINTSERVER_SLEUTEL = os.environ.get('PRINTSERVER_SLEUTEL')
if not PRINTSERVER_SLEUTEL:
    sys.exit('PRINTSERVER_SLEUTEL ontbreekt. Zet deze env var (zelfde waarde als '
             'het veld "Printserver-sleutel" in de kassa-app) voordat je de '
             'printserver start.')

@app.before_request
def vereis_sleutel():
    # CORS-preflight (OPTIONS) stuurt bewust geen custom headers mee — de
    # browser vraagt hiermee alleen toestemming vooraf. Deze blokkeren op de
    # ontbrekende sleutel liet Flask-CORS' eigen Access-Control-Allow-*
    # headers nooit terugkomen, waardoor de browser ook het échte verzoek
    # (met sleutel) daarna weigerde te versturen — de sleutel-check zelf
    # gebeurt sowieso nog op dat echte verzoek.
    if request.method == 'OPTIONS':
        return
    aangeboden = request.headers.get('X-Printserver-Sleutel', '')
    if not hmac.compare_digest(aangeboden, PRINTSERVER_SLEUTEL):
        return jsonify({'ok': False, 'fout': 'Ongeldige of ontbrekende printserver-sleutel'}), 401

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

    # Welke gegevens getoond worden is per artikelcategorie instelbaar in de
    # kassa-app (Artikelen > Bon-instellingen per categorie) — standaard alles
    # tonen als een veld niet is meegestuurd (bv. bij een oudere aanroep).
    toon_naam  = data.get('toonNaam', True)
    toon_plek  = data.get('toonPlek', True)
    toon_tijd  = data.get('toonTijd', True)
    toon_prijs = data.get('toonPrijs', True)

    p.set(align='center', bold=True, width=2, height=2)
    p.text('KRÖSENBERG\n')
    p.set(align='center', bold=False, width=1, height=1)
    p.text('─' * 32 + '\n')

    p.set(align='left')
    if toon_naam: p.text(f'Gast : {naam}\n')
    if toon_plek: p.text(f'Plek : {plek}\n')
    if toon_tijd: p.text(f'Tijd : {tijdstip}\n')
    p.text('─' * 32 + '\n')

    for item in items:
        # item = [naam, {prijs, aantal}]  of  {naam, prijs, aantal}
        if isinstance(item, list):
            inaam, v = item[0], item[1]
            aantal, prijs = v.get('aantal', 1), v.get('prijs', 0)
        else:
            inaam, aantal, prijs = item.get('naam'), item.get('aantal', 1), item.get('prijs', 0)
        regel = f'{aantal}x {inaam}'
        if toon_prijs:
            # Geen euroteken op de losse regels — alleen bij TOTAAL hieronder.
            bedrag = f'{aantal * prijs:.2f}'.replace('.', ',')
            # Rechts uitlijnen op 32 tekens
            spaties = 32 - len(regel) - len(bedrag)
            p.text(regel + ' ' * max(1, spaties) + bedrag + '\n')
        else:
            p.text(regel + '\n')

    if toon_prijs:
        p.text('─' * 32 + '\n')
        p.set(bold=True)
        # Deze (goedkope) printer ondersteunt geen enkele tekenset met een
        # echt eurosymbool en ook geen UTF-8 (getest: elke codepage en rauwe
        # UTF-8-bytes geven onleesbare tekens). "EUR" drukt op elke printer
        # gewoon correct af.
        totaal_str = 'EUR ' + f'{totaal:.2f}'.replace('.', ',')
        label = 'TOTAAL'
        p.text(label + ' ' * (32 - len(label) - len(totaal_str)) + totaal_str + '\n')
        p.set(bold=False)
    p.text('\n\n')
    p.cut()

def print_afrekening(p, data):
    # Afrekenbon: consumpties gegroepeerd per datum (in plaats van per losse
    # bestelling) — meerdere keren hetzelfde artikel op één dag staat hier al
    # opgeteld op één regel (dat optellen gebeurt aan de kassa-app-kant).
    naam    = data.get('naam', '?')
    plek    = data.get('plek', '?')
    groepen = data.get('groepen', [])  # [{datum, regels: [[naam, {prijs, aantal}], ...]}, ...]
    totaal  = data.get('totaal', 0)

    p.set(align='center', bold=True, width=2, height=2)
    p.text('KRÖSENBERG\n')
    p.set(align='center', bold=False, width=1, height=1)
    p.text('─' * 32 + '\n')

    p.set(align='left')
    p.text(f'Gast : {naam}\n')
    p.text(f'Plek : {plek}\n')
    p.text('─' * 32 + '\n')

    for groep in groepen:
        p.set(bold=True)
        p.text(f"{groep.get('datum', '?')}\n")
        p.set(bold=False)
        for regel in groep.get('regels', []):
            inaam, v = regel[0], regel[1]
            aantal, prijs = v.get('aantal', 1), v.get('prijs', 0)
            regeltekst = f'  {aantal}x {inaam}'
            bedrag = f'{aantal * prijs:.2f}'.replace('.', ',')
            spaties = 32 - len(regeltekst) - len(bedrag)
            p.text(regeltekst + ' ' * max(1, spaties) + bedrag + '\n')

    p.text('─' * 32 + '\n')
    p.set(bold=True)
    totaal_str = 'EUR ' + f'{totaal:.2f}'.replace('.', ',')
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
    p = None
    try:
        p = get_printer()
        print_bon(p, data)
        return jsonify({'ok': True})
    except FileNotFoundError:
        return jsonify({'ok': False, 'fout': f'Printer niet gevonden op {PRINTER_DEV}'}), 503
    except Exception as e:
        return jsonify({'ok': False, 'fout': str(e)}), 500
    finally:
        # Zonder dit blijft het device-bestand open staan na elke print. De
        # usblp-driver in de kernel staat maar één open verbinding tegelijk
        # toe, dus zonder sluiten faalt elke volgende print met "Device or
        # resource busy" totdat de printserver herstart wordt.
        if p is not None: p.close()

@app.route('/print-afrekening', methods=['POST'])
def print_afrekening_route():
    data = request.get_json(force=True)
    if not data:
        return jsonify({'ok': False, 'fout': 'Geen data ontvangen'}), 400
    p = None
    try:
        p = get_printer()
        print_afrekening(p, data)
        return jsonify({'ok': True})
    except FileNotFoundError:
        return jsonify({'ok': False, 'fout': f'Printer niet gevonden op {PRINTER_DEV}'}), 503
    except Exception as e:
        return jsonify({'ok': False, 'fout': str(e)}), 500
    finally:
        if p is not None: p.close()

@app.route('/testprint', methods=['POST'])
def testprint():
    p = None
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
    finally:
        if p is not None: p.close()

@app.route('/open-kassa', methods=['POST'])
def open_kassa():
    # Stuurt de kassalade-puls naar de printer (RJ11/RJ12-poort). Pin 2 is de
    # meest gebruikelijke bedrading; als de lade hierop niet opent, is pin 5
    # de eerste die te proberen is (zie PRINTER_CASHDRAW_PIN hieronder).
    p = None
    try:
        p = get_printer()
        p.cashdraw(int(os.environ.get('PRINTER_CASHDRAW_PIN', '2')))
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'ok': False, 'fout': str(e)}), 500
    finally:
        if p is not None: p.close()

@app.route('/status', methods=['GET'])
def status():
    printer_ok = os.path.exists(PRINTER_DEV)
    return jsonify({'ok': printer_ok, 'printer': PRINTER_DEV})

if __name__ == '__main__':
    print(f'Printserver gestart — printer: {PRINTER_DEV}')
    app.run(host='0.0.0.0', port=5000)

#!/usr/bin/env python3
# =========================================================================
# NEXO STUDIO — SERVIDOR LOCAL ESTÁTICO Y API DE CONTACTO
# =========================================================================
import http.server
import socketserver
import json
import os
import re
import time
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from datetime import datetime

PORT = int(os.environ.get('PORT', 3000))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Cargar variables de entorno desde .env si existe
env_path = os.path.join(BASE_DIR, '.env')
if os.path.exists(env_path):
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ[k.strip()] = v.strip().strip('"').strip("'")

# Control de límite de tasa en memoria (IP -> (count, reset_time))
IP_RATE_LIMITS = {}

def is_rate_limited(ip):
    now = time.time()
    record = IP_RATE_LIMITS.get(ip)
    if not record or now > record['reset_time']:
        IP_RATE_LIMITS[ip] = {'count': 1, 'reset_time': now + 3600}
        return False
    if record['count'] >= 5:
        return True
    record['count'] += 1
    return False

def sanitize(text):
    if not isinstance(text, str):
        return ''
    # Eliminar etiquetas HTML básicas y espacios
    clean = re.sub(r'<[^>]*>', '', text).strip()
    return clean

class NexoServerHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def do_POST(self):
        if self.path == '/api/contact' or self.path == '/api/contact/':
            self.handle_contact_api()
        else:
            self.send_error(404, "Endpoint no encontrado")

    def handle_contact_api(self):
        client_ip = self.headers.get('X-Forwarded-For', self.client_address[0])
        if ',' in client_ip:
            client_ip = client_ip.split(',')[0].strip()

        # 1. Rate limiting (máximo 5 por hora por IP)
        if is_rate_limited(client_ip):
            self.send_json_response(429, {
                "error": "Has superado el límite de 5 envíos por hora. Por favor, inténtalo más tarde."
            })
            return

        # 2. Leer cuerpo de la petición
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            raw_body = self.rfile.read(content_length).decode('utf-8')
            data = json.loads(raw_body)
        except Exception:
            self.send_json_response(400, {"error": "Cuerpo de solicitud inválido."})
            return

        # 3. Honeypot check
        if data.get('website_url', '').strip():
            # Rechazar silenciosamente bots
            self.send_json_response(200, {"success": True, "message": "Mensaje procesado"})
            return

        # 4. Tiempo mínimo (3 segundos)
        loaded_at = data.get('form_loaded_at')
        now_ms = time.time() * 1000
        try:
            if not loaded_at or (now_ms - float(loaded_at) < 3000):
                self.send_json_response(400, {
                    "error": "Envío demasiado rápido. Por favor, espera unos segundos antes de enviar."
                })
                return
        except ValueError:
            pass

        # 5. Sanitizar y validar
        recipient = data.get('recipient', 'general').lower()
        name = sanitize(data.get('name', ''))
        email = sanitize(data.get('email', ''))
        phone = sanitize(data.get('phone', ''))
        service = sanitize(data.get('service', 'Consulta General'))
        message = sanitize(data.get('message', ''))
        source_page = sanitize(data.get('source_page', 'NEXO STUDIO'))
        accepted_privacy = (data.get('accepted_privacy') in (True, 'true', 'on', 1)) or (data.get('privacy') in (True, 'true', 'on', 1))

        if not name or len(name) > 100:
            self.send_json_response(400, {"error": "Por favor, introduce un nombre válido (máx. 100 caracteres)."})
            return
        if not email or '@' not in email or len(email) > 120:
            self.send_json_response(400, {"error": "Por favor, introduce un correo electrónico válido."})
            return
        if not message or len(message) > 2000:
            self.send_json_response(400, {"error": "Por favor, introduce un mensaje (entre 1 y 2000 caracteres)."})
            return
        if not accepted_privacy:
            self.send_json_response(400, {"error": "Debes aceptar la política de privacidad."})
            return

        # 6. Destinatarios
        email_andrea = os.environ.get('CONTACT_TO_ANDREA', 'rudyandrearodrigueztorres@gmail.com')
        email_miguel = os.environ.get('CONTACT_TO_MIGUEL', 'miguelangel160397@gmail.com')

        if recipient == 'andrea':
            to_emails = [email_andrea]
            display_name = 'Andrea'
        elif recipient == 'miguel':
            to_emails = [email_miguel]
            display_name = 'Miguel'
        else:
            to_emails = [email_andrea, email_miguel]
            display_name = 'el equipo'

        subject = f"[NEXO STUDIO] Nuevo mensaje para {display_name} – {service}"
        now_str = datetime.now().strftime("%d/%m/%Y, %H:%M:%S")

        # Texto plano
        body_text = f"""
NEXO STUDIO — NUEVO CONTACTO
==================================================
Destinatario: {display_name}
Servicio:     {service}
Fecha:        {now_str}
Origen:       {source_page}

DATOS DEL CONTACTO:
Nombre:       {name}
Correo:       {email}
Teléfono:     {phone if phone else 'No especificado'}

MENSAJE:
{message}
==================================================
* Responde directamente a este correo (Reply-To configurado).
""".strip()

        # HTML
        body_html = f"""
<!DOCTYPE html>
<html lang="es">
<body style="font-family: sans-serif; background-color: #F3F1ED; padding: 24px;">
  <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 20px; overflow: hidden; border: 1px solid rgba(18,24,15,0.12);">
    <div style="background-color: #12180F; padding: 24px 32px; color: #FFFFFF;">
      <span style="background-color: #E6FF00; color: #12180F; font-size: 11px; font-weight: bold; padding: 4px 10px; border-radius: 9999px; text-transform: uppercase;">NEXO STUDIO</span>
      <h1 style="font-size: 20px; margin: 12px 0 0 0; color: #FFFFFF;">Mensaje para {display_name}</h1>
    </div>
    <div style="padding: 32px;">
      <p><strong>De:</strong> {name} (&lt;{email}&gt;)</p>
      <p><strong>Teléfono:</strong> {phone if phone else 'No especificado'}</p>
      <p><strong>Servicio:</strong> {service}</p>
      <p><strong>Página:</strong> {source_page}</p>
      <p><strong>Fecha:</strong> {now_str}</p>
      <hr style="border: none; border-top: 1px solid #F3F1ED; margin: 20px 0;">
      <h3 style="font-size: 14px; text-transform: uppercase; color: #12180F;">Mensaje:</h3>
      <div style="background-color: #F3F1ED; padding: 16px; border-radius: 12px; border-left: 4px solid #E6FF00; white-space: pre-wrap;">{message}</div>
    </div>
    <div style="padding: 16px; background-color: #FAFAFA; text-align: center; font-size: 12px; color: #6E6B5E;">
      NEXO STUDIO • Responde directamente a este correo para contactar a {name}.
    </div>
  </div>
</body>
</html>
""".strip()

        # 7. Envío SMTP si hay credenciales
        smtp_user = os.environ.get('SMTP_USER')
        smtp_pass = os.environ.get('SMTP_PASS')

        if smtp_user and smtp_pass:
            try:
                msg = MIMEMultipart('alternative')
                msg['Subject'] = subject
                msg['From'] = f"NEXO STUDIO <{smtp_user}>"
                msg['To'] = ", ".join(to_emails)
                msg['Reply-To'] = f"{name} <{email}>"
                msg.attach(MIMEText(body_text, 'plain', 'utf-8'))
                msg.attach(MIMEText(body_html, 'html', 'utf-8'))

                with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
                    server.login(smtp_user, smtp_pass)
                    server.sendmail(smtp_user, to_emails, msg.as_string())
                print(f"[SMTP ÉXITO] Correo enviado a {to_emails}")
            except Exception as e:
                print(f"[SMTP ERROR]: {e}")
                self.send_json_response(500, {"error": "Error al enviar el correo a través del servidor SMTP."})
                return
        else:
            print("==================================================")
            print("[SIMULACIÓN DE ENVÍO - DESARROLLO LOCAL]")
            print(f"Destinatarios: {to_emails}")
            print(f"Asunto: {subject}")
            print(f"Remitente: {name} <{email}>")
            print(f"Servicio: {service}")
            print(f"Mensaje: {message}")
            print("==================================================")

        self.send_json_response(200, {
            "success": True,
            "message": f"¡Listo! Recibimos tu mensaje y {'Andrea' if recipient == 'andrea' else ('Miguel' if recipient == 'miguel' else 'el equipo')} te responderá pronto."
        })

    def send_json_response(self, code, data):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

if __name__ == '__main__':
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), NexoServerHandler) as httpd:
        print(f"NEXO STUDIO server running on http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass

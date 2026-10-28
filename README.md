# NEXO STUDIO — Web Oficial & API de Contacto

Sitio web oficial de **NEXO STUDIO**, estudio de diseño gráfico, desarrollo web y marketing digital fundado por **Andrea Rodríguez** y **Miguel Gómez**.

## 🚀 Despliegue en Vercel

Este proyecto está optimizado para desplegarse con un clic en [Vercel](https://vercel.com):

1. **Importar repositorio:** Conecta el repositorio de GitHub en el panel de Vercel.
2. **Framework Preset:** Selecciona `Other` (sitio estático con funciones serverless Node.js automáticas en `/api`).
3. **Variables de Entorno (Environment Variables):**
   Configura las siguientes variables en **Settings > Environment Variables** de tu proyecto en Vercel para que los formularios de contacto envíen correos reales:

   | Variable | Valor / Descripción |
   |---|---|
   | `SMTP_USER` | Correo de Gmail remitente (ej. `rudyandrearodrigueztorres@gmail.com`) |
   | `SMTP_PASS` | Contraseña de aplicación de 16 caracteres de Google |
   | `CONTACT_TO_ANDREA` | Correo de Andrea (`rudyandrearodrigueztorres@gmail.com`) |
   | `CONTACT_TO_MIGUEL` | Correo de Miguel (`miguelangel160397@gmail.com`) |

4. **Desplegar:** Haz clic en **Deploy**.

## 🛠️ Desarrollo Local

```bash
# Iniciar servidor local
python3 server.py
```

El sitio estará disponible en `http://localhost:3000`.

## 📁 Estructura del Proyecto

- `index.html`: Estructura principal, navegación y modales accesibles.
- `pages/`: Vistas dinámicas cargadas por el router SPA (`home`, `websites`, `diseno-grafico`, `marketing`, `creadores`, `blog`, `contacto`, `aviso-legal`, `politica-de-privacidad`, `politica-de-cookies`, `terminos-de-uso`).
- `api/contact.js`: Función serverless en Node.js para procesamiento seguro de formularios y envío de correos vía Nodemailer SMTP.
- `js/`: Lógica cliente (`legal-config.js`, `blog-data.js`, `websites-data.js`, `portfolio-data.js`).
- `assets/`: Ilustraciones vectoriales originales SVG, portafolio de diseño y fotos de creadores.
- `server.py`: Servidor local en Python con soporte para el endpoint `/api/contact`.

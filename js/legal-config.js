// =========================================================================
// NEXO STUDIO — CONFIGURACIÓN CENTRAL DE DATOS LEGALES (legal-config.js)
// Todas las páginas legales (Aviso Legal, Privacidad, Cookies, Términos)
// y los bloques de consentimiento leen los datos exclusivamente de aquí.
// Los campos sin completar se resaltan automáticamente en amarillo.
// =========================================================================

window.NEXO_LEGAL_CONFIG = {
  // 1. Identificación del Titular / Responsable
  titular: "[COMPLETAR: Nombre o Razón Social del Titular]",
  name: "[COMPLETAR: Nombre o Razón Social del Titular]",
  nif_cif: "[COMPLETAR: NIF/CIF]",
  domicilio: "[COMPLETAR: Domicilio social o fiscal completo, Madrid, España]",
  email_derechos: "[COMPLETAR: Correo o canal para ejercer derechos]",
  
  // 2. Actividad y Fecha
  actividad: "Diseño gráfico, desarrollo de páginas web y plataformas digitales, e-commerce y consultoría de marketing digital",
  fecha_actualizacion: "28 de octubre de 2026",

  // 3. Proveedores y Tratamiento de Datos (RGPD)
  plazo_conservacion: "[COMPLETAR: Plazo exacto de conservación (ej. 1 año tras la última comunicación)]",
  proveedor_hosting: "Vercel Inc. (Infraestructura de alojamiento web y funciones serverless)",
  proveedor_email: "Google Ireland Limited (Gmail / Google Workspace - servicio de correo electrónico)",
  transferencias_internacionales: "[COMPLETAR: Garantías aplicables para transferencias internacionales (ej. Cláusulas Contractuales Tipo de la Comisión Europea / Data Privacy Framework)]"
};

// Formateador para resaltar campos pendientes en amarillo neón
window.getLegalFieldHtml = function(fieldKey) {
  const val = window.NEXO_LEGAL_CONFIG[fieldKey] || `[COMPLETAR: ${fieldKey}]`;
  if (typeof val === 'string' && val.includes('[COMPLETAR')) {
    return `<mark class="bg-nexo-neon text-nexo-dark px-2 py-0.5 rounded font-mono font-bold text-xs inline-block tracking-tight shadow-sm select-all">${val}</mark>`;
  }
  return val;
};

// Renderizado reactivo en el DOM para cualquier elemento con data-legal-field="clave"
window.initLegalFields = function() {
  document.querySelectorAll('[data-legal-field]').forEach(el => {
    const key = el.getAttribute('data-legal-field');
    if (key && window.NEXO_LEGAL_CONFIG[key] !== undefined) {
      el.innerHTML = window.getLegalFieldHtml(key);
    }
  });
};

document.addEventListener('DOMContentLoaded', window.initLegalFields);

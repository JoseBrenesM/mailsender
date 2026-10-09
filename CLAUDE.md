# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

CV Scheduler ("CV Scheduler" en la pestaña del navegador) es una app de una sola página en español para automatizar el envío de CVs por Gmail a distintas vacantes. Es 100% client-side: sin backend, sin build, sin `package.json`, sin dependencias npm. El código vive en tres archivos:

- `index.html` — markup y punto de entrada para Vercel
- `mailsender.js` — toda la lógica (estado, autenticación, scheduler, envío)
- `style.css` — tema dark, sin preprocesador
- `apps-script/PixelTracker.gs` — código de referencia (no se ejecuta aquí) para un Web App de Google Apps Script que el usuario despliega en su propia cuenta de Google, usado como endpoint del píxel de tracking de apertura

Dependencias externas cargadas por CDN: Google Fonts (Inter, JetBrains Mono), Tabler Icons webfont, y el script de Google Identity Services (`accounts.google.com/gsi/client`) para la autenticación con Gmail.

## Running it

No hay comando de build, lint o test. Para probar cambios, abre `mailsender.html` directamente en un navegador, o sírvelo con cualquier servidor estático simple (necesario si quieres probar el flujo OAuth de Gmail contra `http://localhost`, ya que el origen debe coincidir con el configurado en Google Cloud Console).

## Architecture

La UI tiene 3 pestañas (`go()` en `mailsender.js`, controla `.panel`/`.tab` vía `TAB_ORDER`), agrupadas por frecuencia de uso, no por cuándo se agregó la funcionalidad:
- **Campañas** (pestaña por defecto): la lista de campañas al frente; el formulario de "Nueva campaña" está colapsado en un `<details>` para no taparla.
- **Plantilla y CVs**: mensaje por defecto, ambos CVs, horarios por defecto — el material reutilizable entre campañas.
- **Conexiones**: Client ID de Gmail, URL del Apps Script (píxel), y la contraseña de seguridad — todo lo que se configura una sola vez.

Toda la lógica está en `mailsender.js`:

- **Estado global `S`**, persistido en `localStorage['cvapp_v2']` en cada `save()`: asunto/cuerpo por defecto, colección abierta de CVs en base64 (`S.cvs = [{id, name, data}]` — no hay límite de cuántos, cada campaña referencia uno por `cvId`), horarios (`times[]`), lista de `campaigns` y flag `gmailConnected`. Hay lógica de migración en `loadState()` para versiones anteriores del esquema (CV único → `cv1`/`cv2` fijos → colección `cvs[]`; campañas sin `sentLog`/`opens`/`followUp`/`cvId`/`body` propio).
- **Autenticación Gmail** vía Google Identity Services (`getTokenClient()` / `google.accounts.oauth2.initTokenClient`), no el implicit flow clásico:
  - `connectGmail()` pide un token con `prompt:'consent'` (primera vez, con popup).
  - `trySilentReconnect()` se llama al cargar la página si `S.gmailConnected` es true, y pide un token con `prompt:''` (sin popup) — funciona mientras Google recuerde el consentimiento en el navegador.
  - `ensureFreshToken()` se llama antes de cada envío para renovar el token si está por vencer (`tokenExpiryTs`).
  - `disconnectGmail()` limpia el token en memoria y el flag `gmailConnected`.
  - El token de acceso en sí sigue viviendo solo en la variable `token` (memoria), nunca se persiste.
- **Motor de campañas** (`scheduleNext()` / `sendEmail()` / `resumeAll()`): cada campaña tiene `times[]`, `days`, contadores `sent/total`, `sentLog[]` (dedupe por día+hora vía `sentKey()`/`yaEnviado()`/`marcarEnviado()`), un `cvId` (referencia a un elemento de `S.cvs`), un `body` propio opcional y un flag `active`. La programación usa `setTimeout` recursivo por campaña (guardado en `timers`), con una ventana de recuperación (`RECOVERY_WINDOW_MS`, 1h) para reintentar envíos perdidos. `resumeAll()` reprograma todas las campañas activas. `reportMissedSchedules()` registra una vez al día los horarios vencidos fuera de la ventana como omitidos; no los envía tarde.
- **CVs por campaña** (`S.cvs[]`, gestionado por `addCV()`/`renameCV()`/`removeCVSlot()`/`downloadCV()`/`renderCVList()`/`populateCVSelect()`): no hay un número fijo de CVs — cada uno se sube con su nombre de archivo real (usado tal cual como adjunto del correo) y un `label` opcional editable ("apodo") para identificarlo en la UI sin depender de cómo se llame el PDF; el `<select>` de "Nueva campaña" y el badge de cada campaña muestran `label || name`. La campaña guarda solo el `cvId` elegido. `downloadCV()` reconstruye el archivo desde el base64 ya guardado en `cv.data` (la misma data que ya se adjunta en `sendEmail()`) para que el usuario pueda bajarlo como respaldo — es de solo lectura, no toca `localStorage` ni el resto del estado.
- **Mensaje por campaña**: cada campaña puede llevar su propio `body` (campo "Cuerpo personalizado" al crearla); si queda vacío, `sendEmail()` cae al `S.body` de la pestaña Plantilla y CVs. El `subject` en cambio siempre es por campaña (autogenerado desde `S.subject` al escribir vacante/empresa, pero editable).
- **Envío con reintentos** (`sendEmail()`): construye a mano un MIME multipart (texto + PDF en base64) y lo postea a `gmail/v1/users/me/messages/send`. Ante `429`/`5xx`/errores de red reintenta con backoff exponencial (hasta 4 intentos). Dispara notificaciones del navegador (`Notification`) cuando la pestaña está oculta.
- **Cifrado local opcional** (`enableLock()` / `disableLock()` / `loadState()`): si el usuario activa "Proteger con contraseña" (pestaña Conexiones → Seguridad), todo `S` se cifra con AES-GCM (clave derivada por PBKDF2) antes de escribirse en `localStorage`; la contraseña se pide al cargar la página y la clave solo vive en memoria (`ENC.key`). El flag de si está protegido y la sal se guardan sin cifrar en `localStorage['cvapp_v2_meta']`.
- **Variables de plantilla**: `{{vacante}}`, `{{empresa}}`, `{{nombre}}` se sustituyen en asunto/cuerpo tanto en el preview (`updateNewSubject()`) como al enviar (`sendEmail()`).
- **Tracking de apertura por píxel** (`S.pixelUrl`, `checkOpens()`, `sendEmail()`): si el usuario configura la URL de un Web App de Apps Script (ver `apps-script/PixelTracker.gs`), cada envío incluye una parte `text/html` (además de la `text/plain` de siempre, dentro de un `multipart/alternative`) con un `<img>` de 1x1 apuntando a ese endpoint con un `trackingId` único + `dest`/`vacante` (para que la Google Sheet del script quede autoexplicativa); el resultado se guarda en `campaign.opens[]` (`{trackingId, sentAt, opened, openedAt, hits}`). `checkOpens()` consulta el estado de los `trackingId` pendientes vía **JSONP** (no `fetch` normal — los Web Apps de Apps Script no devuelven cabeceras CORS para XHR/fetch cross-origin), con throttle de ~15 min, y se llama desde `resumeAll()` y desde el botón manual "Verificar aperturas". Sin `pixelUrl` configurado, el envío es exactamente como antes (solo `text/plain`, sin parte HTML).
  - **Heurística anti-falso-positivo** (`OPEN_GRACE_MS` en `mailsender.js`, `firstOpenedAt`/`lastOpenedAt`/`hits` en la Sheet): Gmail pre-escanea imágenes externas apenas llega el correo, antes de que el destinatario lo abra, lo que dispara el píxel igual. Por eso un hit solo cuenta como apertura real si hay **2+ hits**, o si el (único) hit ocurrió **más de `OPEN_GRACE_MS` (3 min)** después del envío — un solo hit casi inmediato se asume que es ese escaneo automático, no una lectura real.
- **Follow-up automático** (`campaign.followUp`, `scheduleFollowUpIfNeeded()`): al crear una campaña se puede definir un seguimiento opcional (`afterDays`, asunto y cuerpo alternativos). Cuando la campaña termina su tanda normal (`sent >= total`), en vez de desactivarse revisa si el follow-up sigue pendiente y programa un `setTimeout` a `primerEnvio + afterDays`; al vencer, llama a `checkOpens(true)` y si ningún envío fue abierto, manda el seguimiento vía `sendEmail(id, null, 0, true)` (el cuarto parámetro `isFollowUp` hace que se use `followUp.subject`/`followUp.body` en vez de los de la campaña).

## Gotchas

- Los timers de campañas y el token siguen viviendo solo en memoria del tab activo: si se cierra la pestaña, el envío programado se detiene. La reconexión silenciosa + `resumeAll()` mitigan esto al reabrir, pero no hay ejecución en segundo plano real sin backend/Service Worker persistente.
- La reconexión silenciosa (`prompt:''`) depende de que el navegador no bloquee cookies de terceros de Google y de que el usuario no haya revocado el acceso — si falla, cae de vuelta a pedir reconexión manual.
- Si el usuario olvida la contraseña de protección local, los datos cifrados en `localStorage` son irrecuperables (no hay servidor ni recuperación).
- Requiere conexión a internet incluso para la UI (fuentes, iconos y el script de Google Identity Services vienen de CDN).
- El tracking de apertura es aproximado, no un hecho garantizado: Gmail suele proxyear/cachear imágenes externas (el "abierto" refleja la primera vez que se sirvió la imagen, no cada apertura), y si el destinatario bloquea imágenes externas el píxel nunca se dispara aunque sí haya leído el correo (falso negativo). El follow-up automático hereda esta imprecisión: puede reenviarse a alguien que sí abrió el correo pero tenía bloqueadas las imágenes.
- El endpoint de Apps Script vive fuera de este repo (en la cuenta de Google del usuario) — `apps-script/PixelTracker.gs` es solo el código de referencia para desplegarlo, no se ejecuta como parte de esta app.

## Deploy

El proyecto es un sitio estático sin build. Vercel sirve `index.html`, `mailsender.js` y `style.css` desde la raíz, con configuración en `vercel.json`. No hay funciones serverless ni sincronización de datos. Las campañas y CVs permanecen en el almacenamiento local del navegador.

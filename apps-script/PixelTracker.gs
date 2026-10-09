/**
 * PixelTracker — endpoint de tracking de apertura para CV Scheduler.
 *
 * Cómo desplegar:
 * 1. Crea una Google Sheet nueva (o abre una existente que quieras usar para esto).
 * 2. Extensiones → Apps Script.
 * 3. Borra el contenido de Code.gs y pega este archivo completo.
 * 4. Implementar → Nueva implementación → tipo "Aplicación web".
 *    - Ejecutar como: Yo (tu cuenta)
 *    - Quién tiene acceso: Cualquier usuario
 * 5. Copia la URL de la implementación y pégala en Ajustes → "Seguimiento de aperturas" de la app.
 * 6. Si ya tenías una versión anterior de esta hoja (sin las columnas de hora
 *    Costa Rica), abrí este proyecto en el editor de Apps Script, elegí la
 *    función `migrarColumnasHoraCR` en el desplegable de funciones y hacé clic
 *    en ▶ Ejecutar una sola vez — rellena esas columnas en las filas viejas
 *    sin tocar ni borrar nada de lo que ya tenías.
 *
 * Zona horaria: firstOpenedAt/lastOpenedAt (columnas D/E) se guardan en UTC
 * (`toISOString()`) a propósito — es lo que lee `checkOpens()` en mailsender.js
 * para su heurística, y toISOString() siempre es UTC sin importar la zona
 * horaria configurada en la Hoja o en el proyecto de Apps Script (por eso
 * cambiar esa configuración no alcanza). Para poder leer la hora a simple
 * vista, se agregan columnas G/H con la misma hora ya convertida a hora de
 * Costa Rica (`CR_TIMEZONE`), solo para uso humano — el código nunca las lee.
 *
 * Limitaciones a tener en cuenta (ver CLAUDE.md):
 * - Gmail suele pre-escanear las imágenes externas de un correo (por
 *   seguridad/antimalware) apenas llega, ANTES de que el destinatario lo
 *   abra — eso ya dispara el píxel y produce un falso positivo. Por eso se
 *   guarda lastOpenedAt y hits (no solo la primera apertura): la app aplica
 *   una heurística en `checkOpens()` (mailsender.js) para distinguir un
 *   escaneo automático de una apertura real.
 * - Si el destinatario bloquea imágenes externas, el píxel nunca se dispara
 *   aunque sí haya leído el correo (falso negativo).
 * - Cada píxel dispara su propia ejecución de doGet(), y pueden correr en
 *   paralelo (ej. dos correos enviados casi a la vez). registerOpen_() usa
 *   LockService para serializar la escritura y evitar que una ejecución
 *   pise la fila que otra está por crear.
 * - doGet() siempre responde vía ContentService (no se devuelve un Blob/GIF
 *   real): un Web App de Apps Script solo admite HtmlOutput/TextOutput como
 *   valor de retorno, devolver un Blob crudo revienta con "el valor que
 *   muestra no es un valor de retorno admitido". Como el <img> del correo
 *   se manda oculto (display:none), no importa que no sea una imagen real —
 *   lo único que importa es que la petición HTTP llegue y quede registrada.
 */

var SHEET_NAME = 'Opens';
var CR_TIMEZONE = 'America/Costa_Rica';
var HEADERS = ['trackingId', 'dest', 'vacante', 'firstOpenedAt', 'lastOpenedAt', 'hits',
               'firstOpenedAt (CR)', 'lastOpenedAt (CR)'];

function getSheet_(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if(!sheet){
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
  } else if(sheet.getRange(1, 7).getValue() === ''){
    // Hoja creada antes de agregar las columnas de hora CR — se completa
    // solo el header, sin tocar ninguna fila de datos existente.
    sheet.getRange(1, 7, 1, 2).setValues([[HEADERS[6], HEADERS[7]]]);
  }
  return sheet;
}

function formatCR_(date){
  return Utilities.formatDate(date, CR_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

function findRow_(sheet, id){
  var data = sheet.getDataRange().getValues();
  for(var i = 1; i < data.length; i++){
    if(data[i][0] === id) return i + 1; // número de fila 1-indexado
  }
  return -1;
}

// Guarda cada hit del píxel. Se registra firstOpenedAt (para saber cuándo se
// vio por primera vez) y lastOpenedAt + hits (para que la app pueda distinguir
// un escaneo automático de Gmail de una apertura real — ver doGet()).
//
// Usa LockService porque cada <img> dispara su propia ejecución de doGet(),
// y Apps Script puede correr varias en paralelo (ej. dos correos enviados
// casi a la vez, o el pre-escaneo de Gmail llegando para ambos casi
// simultáneo). Sin el lock, dos ejecuciones pueden leer la Sheet ANTES de
// que la otra termine de escribir, ambas concluyen "no existe esta fila,
// hay que agregar" y una pisa la fila de la otra — la causa de que al
// enviar 2 correos a la vez solo apareciera 1 fila en el Sheet.
function registerOpen_(id, dest, vacante){
  var lock = LockService.getScriptLock();
  lock.waitLock(10000); // hasta 10s esperando que otra ejecución termine
  try{
    var sheet = getSheet_();
    var row = findRow_(sheet, id);
    var now = new Date();
    var nowIso = now.toISOString();
    var nowCR = formatCR_(now);
    if(row === -1){
      sheet.appendRow([id, dest || '', vacante || '', nowIso, nowIso, 1, nowCR, nowCR]);
    } else {
      var hits = sheet.getRange(row, 6).getValue() || 0;
      sheet.getRange(row, 6).setValue(hits + 1);
      sheet.getRange(row, 5).setValue(nowIso); // lastOpenedAt (UTC, la usa la app)
      sheet.getRange(row, 8).setValue(nowCR);  // lastOpenedAt (CR), solo lectura humana
      if(sheet.getRange(row, 7).getValue() === ''){
        // Fila vieja que todavía no tenía columna CR — se completa ahora con
        // el firstOpenedAt ya guardado en la columna D, sin inventar nada.
        var firstIso = sheet.getRange(row, 4).getValue();
        sheet.getRange(row, 7).setValue(formatCR_(firstIso ? new Date(firstIso) : now));
      }
    }
  } finally {
    lock.releaseLock();
  }
}

// Migración manual (opcional): rellena las columnas de hora CR en filas que
// ya existían antes de este cambio, sin esperar a que reciban un hit nuevo.
// Ejecutar UNA VEZ desde el editor de Apps Script (elegí esta función en el
// desplegable y hacé clic en ▶). No borra ni modifica las columnas A-F.
function migrarColumnasHoraCR(){
  var sheet = getSheet_();
  var data = sheet.getDataRange().getValues();
  for(var i = 1; i < data.length; i++){
    var firstIso = data[i][3], lastIso = data[i][4];
    var firstCR = data[i][6], lastCR = data[i][7];
    if(firstIso && !firstCR) sheet.getRange(i + 1, 7).setValue(formatCR_(new Date(firstIso)));
    if(lastIso && !lastCR) sheet.getRange(i + 1, 8).setValue(formatCR_(new Date(lastIso)));
  }
}

function getStatus_(ids){
  var sheet = getSheet_();
  var data = sheet.getDataRange().getValues();
  var result = {};
  for(var i = 1; i < data.length; i++){
    var id = data[i][0];
    if(ids.indexOf(id) !== -1){
      result[id] = { first: data[i][3], last: data[i][4], hits: data[i][5] };
    }
  }
  return result;
}

function doGet(e){
  var params = (e && e.parameter) || {};

  try{
    // Consulta de estado — usada por la app vía JSONP (los Web Apps de Apps
    // Script no devuelven cabeceras CORS, así que un fetch() normal fallaría;
    // por eso se responde como script ejecutable si viene "callback").
    if(params.action === 'status'){
      var ids = (params.ids || '').split(',').filter(function(x){ return x; });
      var result = getStatus_(ids);
      if(params.callback){
        var body = params.callback + '(' + JSON.stringify(result) + ');';
        return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JAVASCRIPT);
      }
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }

    // Petición del píxel en sí — se registra la apertura junto con a quién
    // se le envió, para poder identificarlo directo en la Sheet.
    if(params.id){
      registerOpen_(params.id, params.dest, params.vacante);
    }
  }catch(err){
    // Nunca dejar que un error de Sheets rompa la respuesta del píxel/status.
  }

  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}

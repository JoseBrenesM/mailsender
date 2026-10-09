# CV Scheduler

Aplicación estática para programar envíos de CV desde Gmail. La interfaz, las campañas y los archivos se procesan en el navegador; no requiere build ni backend.

## Ejecutar localmente

Abre `index.html` en un navegador. Para usar OAuth de Google, sirve el proyecto mediante un servidor local y agrega ese origen autorizado en Google Cloud Console.

## Publicar en Vercel

1. Sube estos archivos a un repositorio GitHub.
2. Importa el repositorio en Vercel. Déjalo como proyecto estático, sin comando de build y con la raíz del proyecto como directorio de salida.
3. Copia el dominio asignado por Vercel.
4. En el cliente OAuth de Google, agrega el dominio como origen JavaScript autorizado. Habilita Gmail API y conserva el scope de envío que usa la app.
5. Abre el dominio y confirma que la app carga y que Google permite la conexión.

## Datos y programación

Las campañas y los CV se guardan en el almacenamiento del navegador. No se sincronizan con otros dispositivos y no se migran al publicar el sitio. Mantén abierta la pestaña y el navegador para que corran los temporizadores. Los horarios perdidos solo se recuperan durante la primera hora; después se registran como omitidos para evitar envíos atrasados acumulados.

La autenticación usa Google Identity Services y el token de acceso vive en memoria. Puede ser necesario volver a conectar Gmail si Google no permite la reconexión silenciosa.

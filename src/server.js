import { createApp } from './app.js';
import { createDb } from './db.js';

const port = Number(process.env.PORT ?? 3000);
createApp(createDb()).server().listen(port, () => console.log(`Listening on http://localhost:${port}`));

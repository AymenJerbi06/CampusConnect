require('dotenv').config({ path: './.env' });
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });
p.query("UPDATE users SET plan='cross_campus', subscription_status='active' WHERE name='Aymen Jerbi'")
  .then(r => { console.log('Updated rows:', r.rowCount); p.end(); })
  .catch(e => { console.error(e.message); p.end(); });

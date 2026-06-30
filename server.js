const app = require('./app');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';

app.listen(PORT, () => {
  console.log(`Seminar registration server running at http://localhost:${PORT}`);
  console.log(`Admin export: http://localhost:${PORT}/api/admin/export.csv?key=${ADMIN_KEY}`);
});

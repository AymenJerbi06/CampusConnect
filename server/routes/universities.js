const express = require('express');
const router  = express.Router();
const { query } = require('../db');

router.get('/', async (req, res) => {
  return res.json(await query('SELECT * FROM universities ORDER BY name'));
});

module.exports = router;

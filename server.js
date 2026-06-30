require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_PER_ORG = 5;

const BRANCHES_FILE = path.join(__dirname, 'branches.json');
const branches = JSON.parse(fs.readFileSync(BRANCHES_FILE, 'utf8'));

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function normalize(str) {
  return String(str || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function toClientRecord(row) {
  return {
    id: row.id,
    timestamp: row.created_at,
    orgName: row.org_name,
    branch: row.branch,
    fullName: row.full_name,
    position: row.position,
    trainingDate: row.training_date,
    ackPurpose: row.ack_purpose,
    consentGeneral: row.consent_general,
    consentSensitive: row.consent_sensitive,
    ackWithdraw: row.ack_withdraw,
  };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/branches', (req, res) => {
  res.json(branches);
});

app.post('/api/register', async (req, res) => {
  const {
    orgName,
    branch,
    fullName,
    position,
    trainingDate,
    ackPurpose,
    consentGeneral,
    consentSensitive,
    ackWithdraw,
  } = req.body || {};

  if (!orgName || !branch || !fullName || !position || !trainingDate) {
    return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  }
  if (!branches[branch] || !branches[branch].includes(orgName)) {
    return res.status(400).json({ error: 'สาขาหรือหน่วยงานไม่ถูกต้อง' });
  }
  if (!ackPurpose || !consentGeneral || !ackWithdraw) {
    return res.status(400).json({ error: 'กรุณายืนยันการรับทราบและยินยอมตามที่ระบุ' });
  }

  const { count, error: countError } = await supabase
    .from('seminar_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('org_name', orgName);

  if (countError) {
    console.error(countError);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่' });
  }
  if ((count || 0) >= MAX_PER_ORG) {
    return res.status(409).json({
      error: `หน่วยงาน "${orgName}" มีผู้ลงทะเบียนครบ ${MAX_PER_ORG} ท่านแล้ว ไม่สามารถลงทะเบียนเพิ่มได้`,
    });
  }

  const { data, error: insertError } = await supabase
    .from('seminar_registrations')
    .insert({
      org_name: orgName,
      branch,
      full_name: String(fullName).trim(),
      full_name_normalized: normalize(fullName),
      position: String(position).trim(),
      training_date: trainingDate,
      ack_purpose: !!ackPurpose,
      consent_general: !!consentGeneral,
      consent_sensitive: !!consentSensitive,
      ack_withdraw: !!ackWithdraw,
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      return res.status(409).json({
        error: `พบรายชื่อ "${fullName}" ลงทะเบียนกับหน่วยงาน "${orgName}" ไว้แล้ว`,
      });
    }
    console.error(insertError);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่' });
  }

  res.json({ ok: true, record: toClientRecord(data) });
});

app.get('/api/org-count', async (req, res) => {
  const { orgName } = req.query;
  if (!orgName) return res.status(400).json({ error: 'missing orgName' });

  const { count, error } = await supabase
    .from('seminar_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('org_name', orgName);

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
  }
  res.json({ count: count || 0, remaining: Math.max(0, MAX_PER_ORG - (count || 0)) });
});

// --- Admin (shared key query param; replace with stronger auth before wider rollout) ---
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';

function requireAdmin(req, res, next) {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(403).send('Forbidden');
  }
  next();
}

app.get('/api/admin/registrations', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('seminar_registrations')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
  }
  res.json(data.map(toClientRecord));
});

app.get('/api/admin/export.csv', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('seminar_registrations')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error(error);
    return res.status(500).send('Error generating export');
  }

  const headers = [
    'ประทับเวลา',
    'รายชื่อรัฐวิสาหกิจ/สคร.',
    'สาขาที่สังกัด',
    'ชื่อ-นามสกุล',
    'ตำแหน่ง',
    'วันที่เข้าร่วมการอบรม',
    'รับทราบวัตถุประสงค์',
    'ยินยอมข้อมูลทั่วไป',
    'ยินยอมข้อมูลอ่อนไหว',
    'รับทราบสิทธิถอนความยินยอม',
  ];
  const rows = data.map((r) => [
    r.created_at,
    r.org_name,
    r.branch,
    r.full_name,
    r.position,
    r.training_date,
    r.ack_purpose ? 'รับทราบ' : '',
    r.consent_general ? 'ยินยอม' : '',
    r.consent_sensitive ? 'ยินยอม' : '',
    r.ack_withdraw ? 'รับทราบ' : '',
  ]);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((row) => row.map(esc).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="registrations.csv"');
  res.send('﻿' + csv);
});

app.listen(PORT, () => {
  console.log(`Seminar registration server running at http://localhost:${PORT}`);
  console.log(`Admin export: http://localhost:${PORT}/api/admin/export.csv?key=${ADMIN_KEY}`);
});

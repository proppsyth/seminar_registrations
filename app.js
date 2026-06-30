require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const CHECKIN_CAP = 5;

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

function buildFullName(title, firstName, lastName) {
  return [title, firstName, lastName].filter(Boolean).join(' ').trim();
}

function toClientRecord(row) {
  return {
    id: row.id,
    timestamp: row.created_at,
    orgName: row.org_name,
    branch: row.branch,
    title: row.title,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    position: row.position,
    trainingDate: row.training_date,
    ackPurpose: row.ack_purpose,
    consentGeneral: row.consent_general,
    consentSensitive: row.consent_sensitive,
    ackWithdraw: row.ack_withdraw,
    isCheckedIn: row.is_checked_in,
    checkedInAt: row.checked_in_at,
    isReplaced: row.is_replaced,
    replacesRegistrationId: row.replaces_registration_id,
  };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/branches', (req, res) => {
  res.json(branches);
});

// List active (non-replaced) registrants for an org — used by the registration page's
// "substitute for a no-show" picker and the check-in page.
app.get('/api/org-registrations', async (req, res) => {
  const { orgName } = req.query;
  if (!orgName) return res.status(400).json({ error: 'missing orgName' });

  const { data, error } = await supabase
    .from('seminar_registrations')
    .select('*')
    .eq('org_name', orgName)
    .eq('is_replaced', false)
    .order('created_at', { ascending: true });

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
  }
  res.json(data.map(toClientRecord));
});

app.post('/api/register', async (req, res) => {
  const {
    orgName,
    branch,
    title,
    firstName,
    lastName,
    phone,
    email,
    position,
    trainingDate,
    ackPurpose,
    consentGeneral,
    consentSensitive,
    ackWithdraw,
    replacesRegistrationId,
  } = req.body || {};

  if (!orgName || !branch || !title || !firstName || !lastName || !phone || !position || !trainingDate) {
    return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  }
  if (!branches[branch] || !branches[branch].includes(orgName)) {
    return res.status(400).json({ error: 'สาขาหรือหน่วยงานไม่ถูกต้อง' });
  }
  if (!/^[0-9-+() ]{9,15}$/.test(String(phone).trim())) {
    return res.status(400).json({ error: 'กรุณากรอกเบอร์โทรศัพท์ให้ถูกต้อง' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'กรุณากรอกอีเมลให้ถูกต้อง' });
  }
  if (!ackPurpose || !consentGeneral || !ackWithdraw) {
    return res.status(400).json({ error: 'กรุณายืนยันการรับทราบและยินยอมตามที่ระบุ' });
  }

  let replacesId = null;
  if (replacesRegistrationId) {
    const { data: target, error: targetError } = await supabase
      .from('seminar_registrations')
      .select('id, org_name, is_replaced')
      .eq('id', replacesRegistrationId)
      .single();

    if (targetError || !target || target.org_name !== orgName || target.is_replaced) {
      return res.status(400).json({ error: 'ไม่พบรายชื่อที่ต้องการแทนที่ หรือถูกแทนที่ไปแล้ว' });
    }
    replacesId = target.id;
  }

  const fullName = buildFullName(title, firstName, lastName);
  const fullNameNormalized = normalize(fullName);

  const { data, error: insertError } = await supabase
    .from('seminar_registrations')
    .insert({
      org_name: orgName,
      branch,
      title: String(title).trim(),
      first_name: String(firstName).trim(),
      last_name: String(lastName).trim(),
      full_name: fullName,
      full_name_normalized: fullNameNormalized,
      phone: String(phone).trim(),
      email: email ? String(email).trim() : null,
      position: String(position).trim(),
      training_date: trainingDate,
      ack_purpose: !!ackPurpose,
      consent_general: !!consentGeneral,
      consent_sensitive: !!consentSensitive,
      ack_withdraw: !!ackWithdraw,
      replaces_registration_id: replacesId,
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

  if (replacesId) {
    // Mark the original as replaced and free up their check-in seat (if any) for the substitute.
    await supabase
      .from('seminar_registrations')
      .update({ is_replaced: true, is_checked_in: false, checked_in_at: null })
      .eq('id', replacesId);
  }

  res.json({ ok: true, record: toClientRecord(data) });
});

// --- Check-in (day-of-event) ---

app.get('/api/checkin-count', async (req, res) => {
  const { orgName } = req.query;
  if (!orgName) return res.status(400).json({ error: 'missing orgName' });

  const { count, error } = await supabase
    .from('seminar_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('org_name', orgName)
    .eq('is_checked_in', true);

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
  }
  res.json({ count: count || 0, remaining: Math.max(0, CHECKIN_CAP - (count || 0)), cap: CHECKIN_CAP });
});

app.post('/api/checkin', async (req, res) => {
  const { registrationId } = req.body || {};
  if (!registrationId) return res.status(400).json({ error: 'missing registrationId' });

  const { data: reg, error: regError } = await supabase
    .from('seminar_registrations')
    .select('*')
    .eq('id', registrationId)
    .single();

  if (regError || !reg) {
    return res.status(404).json({ error: 'ไม่พบรายชื่อนี้' });
  }
  if (reg.is_replaced) {
    return res.status(409).json({ error: 'รายชื่อนี้ถูกแทนที่ด้วยผู้ลงทะเบียนคนอื่นแล้ว ไม่สามารถเช็คอินได้' });
  }
  if (reg.is_checked_in) {
    return res.json({ ok: true, record: toClientRecord(reg), alreadyCheckedIn: true });
  }

  const { count, error: countError } = await supabase
    .from('seminar_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('org_name', reg.org_name)
    .eq('is_checked_in', true);

  if (countError) {
    console.error(countError);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
  }
  if ((count || 0) >= CHECKIN_CAP) {
    return res.status(409).json({
      error: `หน่วยงาน "${reg.org_name}" เช็คอินครบ ${CHECKIN_CAP} ท่านแล้ว กรุณาติดต่อเจ้าหน้าที่หน้างาน`,
    });
  }

  const { data, error: updateError } = await supabase
    .from('seminar_registrations')
    .update({ is_checked_in: true, checked_in_at: new Date().toISOString() })
    .eq('id', registrationId)
    .select()
    .single();

  if (updateError) {
    console.error(updateError);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
  }

  res.json({ ok: true, record: toClientRecord(data) });
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

app.delete('/api/admin/registrations/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  // Clear any registration that points at this one as "replaces" so we don't leave a dangling reference.
  await supabase.from('seminar_registrations').update({ replaces_registration_id: null }).eq('replaces_registration_id', id);

  const { error } = await supabase.from('seminar_registrations').delete().eq('id', id);
  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'ลบไม่สำเร็จ' });
  }
  res.json({ ok: true });
});

app.post('/api/admin/checkin/:id/undo', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase
    .from('seminar_registrations')
    .update({ is_checked_in: false, checked_in_at: null })
    .eq('id', id);

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
  }
  res.json({ ok: true });
});

app.get('/api/admin/checkin-summary', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('seminar_registrations')
    .select('org_name, branch, is_checked_in, is_replaced');

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
  }

  const orgAgg = {};
  let totalCheckedIn = 0;
  let totalActive = 0;
  data.forEach((r) => {
    if (r.is_replaced) return;
    totalActive += 1;
    if (!orgAgg[r.org_name]) orgAgg[r.org_name] = { branch: r.branch, registered: 0, checkedIn: 0 };
    orgAgg[r.org_name].registered += 1;
    if (r.is_checked_in) {
      orgAgg[r.org_name].checkedIn += 1;
      totalCheckedIn += 1;
    }
  });

  res.json({
    totalActive,
    totalCheckedIn,
    cap: CHECKIN_CAP,
    orgs: Object.entries(orgAgg).map(([orgName, v]) => ({ orgName, ...v })),
  });
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
    'คำนำหน้า',
    'ชื่อ',
    'นามสกุล',
    'เบอร์โทรศัพท์',
    'อีเมล',
    'ตำแหน่ง',
    'วันที่เข้าร่วมการอบรม',
    'รับทราบวัตถุประสงค์',
    'ยินยอมข้อมูลทั่วไป',
    'ยินยอมข้อมูลอ่อนไหว',
    'รับทราบสิทธิถอนความยินยอม',
    'เช็คอินแล้ว',
    'เวลาเช็คอิน',
    'ถูกแทนที่',
  ];
  const rows = data.map((r) => [
    r.created_at,
    r.org_name,
    r.branch,
    r.title,
    r.first_name,
    r.last_name,
    r.phone,
    r.email,
    r.position,
    r.training_date,
    r.ack_purpose ? 'รับทราบ' : '',
    r.consent_general ? 'ยินยอม' : '',
    r.consent_sensitive ? 'ยินยอม' : '',
    r.ack_withdraw ? 'รับทราบ' : '',
    r.is_checked_in ? 'เช็คอินแล้ว' : '',
    r.checked_in_at || '',
    r.is_replaced ? 'ถูกแทนที่แล้ว' : '',
  ]);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((row) => row.map(esc).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="registrations.csv"');
  res.send('﻿' + csv);
});

module.exports = app;

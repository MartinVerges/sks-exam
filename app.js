/* SKS Theorie Trainer — Vanilla PWA
   - Fragen/Antworten aus data/*.json
   - KI-Bewertung via OpenAI-kompatibler /chat/completions
   - Sprache: /audio/transcriptions (STT) + /audio/speech (TTS)
   - Fortschritt & Spaced-Repetition (Leitner) im localStorage
*/
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// ---------- Settings ----------
const SETTINGS_KEY = 'sks.settings';
const PROGRESS_KEY = 'sks.progress';
const DEFAULT_SETTINGS = {
  // Vorübergehend OpenAI (hat CORS -> läuft direkt im Browser, ohne Proxy).
  // Für croit-Gateway: apiUrl 'https://llm.croit.io/v1', model 'qwen' (sobald CORS dort aktiv ist).
  apiUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-5.6-sol',   // schnell + smart; Alternativen: gpt-5.4-mini (schneller), gpt-5.6-terra/luna
  disableThinking: true,   // wird für api.openai.com automatisch ignoriert (chatExtra); relevant für Qwen3/vLLM
  sttEnabled: true,
  sttModel: 'whisper-1',
  sttPrompt: '',      // eigene Fachbegriffe (Komma-getrennt) als STT-Kontext
  ttsEnabled: false,
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  autoRead: false,
  scope: 'all',      // 'all' oder Array von Fragebogen-Nummern
  mode: 'smart',     // smart | new | wrong | sequential
};
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
let settings = loadSettings();

// ---------- Progress (Leitner) ----------
// box 0..5; wrong -> 0, correct -> +1 (max 5). mastered = box>=4.
function loadProgress() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}'); } catch { return {}; }
}
function saveProgress(p) { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); }
let progress = loadProgress();

function getRec(id) {
  return progress[id] || { box: 0, correct: 0, wrong: 0, seen: 0, last: null, lastTs: 0 };
}
function isMastered(id) { const r = progress[id]; return r && r.box >= 4; }

// ---------- Data ----------
let INDEX = null;
let QUESTIONS = [];            // flat list
const QBY_ID = new Map();

async function loadData() {
  INDEX = await fetch('data/index.json').then(r => r.json());
  const files = INDEX.fragebogen.map(f => `data/fragebogen_${String(f.fragebogen).padStart(2, '0')}.json`);
  const sets = await Promise.all(files.map(f => fetch(f).then(r => r.json())));
  QUESTIONS = [];
  for (const s of sets) for (const q of s.questions) { QUESTIONS.push(q); QBY_ID.set(q.id, q); }
}

// ---------- Selection ----------
function scopedQuestions() {
  if (settings.scope === 'all' || !Array.isArray(settings.scope) || !settings.scope.length) return QUESTIONS;
  const set = new Set(settings.scope);
  return QUESTIONS.filter(q => set.has(q.fragebogen));
}
const BOX_WEIGHT = { new: 3, 0: 6, 1: 4, 2: 3, 3: 2, 4: 1, 5: 0.4 };
function weightFor(q) {
  const r = progress[q.id];
  if (!r || r.seen === 0) return BOX_WEIGHT.new;
  return BOX_WEIGHT[r.box] ?? 1;
}
let lastServedId = null;
let seqPointer = 0;

function pickNext() {
  let pool = scopedQuestions();
  if (!pool.length) return null;
  if (settings.mode === 'new') pool = pool.filter(q => !progress[q.id] || progress[q.id].seen === 0);
  else if (settings.mode === 'wrong') pool = pool.filter(q => progress[q.id] && progress[q.id].box <= 1 && progress[q.id].seen > 0);
  if (settings.mode === 'sequential') {
    const ordered = [...pool].sort((a, b) => a.fragebogen - b.fragebogen || a.number - b.number);
    if (!ordered.length) return null;
    const q = ordered[seqPointer % ordered.length];
    seqPointer++;
    return q;
  }
  if (!pool.length) return null;
  // weighted random, avoid immediate repeat
  let candidates = pool.filter(q => q.id !== lastServedId);
  if (!candidates.length) candidates = pool;
  const weights = candidates.map(weightFor);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return candidates[Math.floor(Math.random() * candidates.length)];
  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) { r -= weights[i]; if (r <= 0) return candidates[i]; }
  return candidates[candidates.length - 1];
}

function applyResult(id, verdict) {
  const r = getRec(id);
  r.prevBox = r.box;        // Box vor diesem Versuch (für spätere manuelle Korrektur)
  r.seen++;
  r.lastTs = Date.now();
  r.last = verdict;
  if (verdict === 'correct') { r.correct++; r.box = Math.min(5, r.box + 1); }
  else if (verdict === 'partial') { r.box = 1; /* zurück in aktive Wiederholung */ }
  else { r.wrong++; r.box = 0; }
  progress[id] = r;
  saveProgress(progress);
}

// Manuelle Korrektur der letzten Wertung (überstimmt die KI), ohne 'seen' erneut zu zählen.
function overrideResult(id, verdict) {
  const r = getRec(id);
  if (r.last === verdict) return;
  if (r.last === 'correct') r.correct = Math.max(0, r.correct - 1);
  else if (r.last === 'wrong') r.wrong = Math.max(0, r.wrong - 1);
  const base = (r.prevBox != null) ? r.prevBox : 0;
  if (verdict === 'correct') { r.correct++; r.box = Math.min(5, base + 1); }
  else if (verdict === 'partial') { r.box = 1; }
  else { r.wrong++; r.box = 0; }
  r.last = verdict;
  progress[id] = r;
  saveProgress(progress);
}

// ---------- API ----------
function apiBase() { return (settings.apiUrl || '').replace(/\/+$/, ''); }
function authHeaders(extra = {}) {
  const h = { ...extra };
  if (settings.apiKey) h['Authorization'] = 'Bearer ' + settings.apiKey;
  return h;
}
function chatExtra() {
  // OpenAI lehnt unbekannte Parameter mit HTTP 400 ab -> chat_template_kwargs nur an
  // selbst-gehostete (vLLM) Endpoints senden, nie an api.openai.com.
  const isOpenAI = /(^|\.)openai\.com/i.test(apiBase());
  return (settings.disableThinking && !isOpenAI) ? { chat_template_kwargs: { enable_thinking: false } } : {};
}
// GPT-5 / o-Serie: max_completion_tokens statt max_tokens, kein temperature (nur Default 1).
function isNewOpenAIModel(model) { return /^(gpt-5|o[1345])/i.test(model || ''); }
function buildChatBody(messages, maxTok) {
  const body = { model: settings.model, messages, ...chatExtra() };
  if (isNewOpenAIModel(settings.model)) {
    body.max_completion_tokens = maxTok;   // temperature weglassen (Reasoning-Modelle)
  } else {
    body.max_tokens = maxTok;
    body.temperature = 0.1;
  }
  return body;
}
function stripJson(text) {
  if (!text) return text;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return t;
}

// Score-Schwellen für die automatische Vorauswahl des Verdicts (manuell überschreibbar).
const AUTO_CORRECT_PCT = 75;   // >= 75% -> Vorauswahl "richtig"
const AUTO_WRONG_PCT = 50;     // <= 50% -> Vorauswahl "falsch"

const GRADE_SYSTEM =
`Du bist ein WOHLWOLLENDER Prüfer für die deutsche SKS-Theorieprüfung (Sportküstenschifferschein).
Du bewertest die Antwort eines Lernenden gegen eine Musterantwort.

BEWERTUNGSGRUNDSÄTZE (wichtig):
- Es zählt die SINNGEMÄSSE, weitgehende inhaltliche Übereinstimmung — KEIN 100%-Wortlaut-Match, keine Vollständigkeit in jedem Detail nötig.
- Beantwortet der Lernende die Frage sinnvoll richtig und liegt nahe an dem, was die Musterantwort erwartet, ist das "correct".
- Die fett markierten Schlüsselwörter sind die Kernbegriffe. Kommen sie (auch als Synonym/Umschreibung) vor, tendiere STARK zu "correct".
- Sei großzügig zugunsten des Prüflings. Bewerte NICHT überkorrekt, verlange keine wörtliche Wiedergabe.
- Rechtschreibung, Grammatik und Transkriptionsfehler (Spracheingabe) komplett ignorieren.
- Falls die Musterantwort auf einer Skizze/Grafik beruht, bewerte die textliche Beschreibung des Konzepts sehr wohlwollend.
- ABER: offensichtlich FALSCHE oder widersprüchliche Sachaussagen werden auch als falsch bewertet — Wohlwollen heißt nicht, Fehlinformationen durchzuwinken.

Der wichtigste Wert ist ein FAIRER score von 0-100, der die inhaltliche Übereinstimmung mit der Musterantwort abbildet:
- score >= 75: Frage sinngemäß richtig beantwortet, nahe an der Musterantwort (Kernaussage/Schlüsselwörter sinngemäß da).
- score 51-74: grundsätzlich richtige Richtung, aber Wesentliches fehlt oder ist zu vage.
- score <= 50: falsche Kernaussage, am Thema vorbei oder viel zu wenig.
Setze verdict passend zum score (>=75 correct, <=50 wrong, sonst partial).

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt, ohne weiteren Text:
{"verdict":"correct|partial|wrong","score":0-100,"feedback":"1-2 Sätze freundliches, konstruktives Feedback auf Deutsch","matched_keywords":[..],"missing_keywords":[..]}`;

async function gradeAnswer(q, userAnswer) {
  const base = apiBase();
  if (!base) throw new Error('Keine API-URL konfiguriert (Einstellungen).');
  const hasImg = (q.question_images.length + q.answer_images.length) > 0;
  const userMsg =
`FRAGE:\n${q.question}\n\nMUSTERANTWORT:\n${q.answer}\n\nWICHTIGE SCHLÜSSELWÖRTER (fett): ${q.keywords.join(', ') || '(keine)'}\n` +
(hasImg ? `\nHINWEIS: Zu dieser Frage gehört eine Skizze/Grafik; bewerte die Beschreibung wohlwollend.\n` : '') +
`\nANTWORT DES LERNENDEN:\n${userAnswer}\n\nGib das JSON-Ergebnis.`;
  const body = buildChatBody([
    { role: 'system', content: GRADE_SYSTEM },
    { role: 'user', content: userMsg },
  ], 2000);   // großzügig: Reasoning-Modelle brauchen Platz vor dem JSON-Output
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Bewertung fehlgeschlagen (${res.status}). ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  // Reasoning-Modelle: finale Antwort in content; falls leer, im reasoning-Feld suchen
  const content = (msg.content && msg.content.trim()) ? msg.content : (msg.reasoning || '');
  if (!content) throw new Error('Leere KI-Antwort (evtl. Token-Limit im Reasoning). Bitte erneut versuchen.');
  let parsed;
  try { parsed = JSON.parse(stripJson(content)); }
  catch { throw new Error('KI-Antwort war kein gültiges JSON. Rohtext: ' + content.slice(0, 160)); }
  // Verdict wird über den Score festgelegt: >=75% richtig, <=50% falsch, dazwischen teilweise
  const score = Math.max(0, Math.min(100, Number(parsed.score) || 0));
  let verdict;
  if (score >= AUTO_CORRECT_PCT) verdict = 'correct';
  else if (score <= AUTO_WRONG_PCT) verdict = 'wrong';
  else verdict = 'partial';
  return {
    verdict,
    score,
    feedback: String(parsed.feedback || ''),
    matched_keywords: Array.isArray(parsed.matched_keywords) ? parsed.matched_keywords : [],
    missing_keywords: Array.isArray(parsed.missing_keywords) ? parsed.missing_keywords : [],
  };
}

// Immer mitgesendeter Kern: kurze Orientierungs-/Grundbegriffe, die Whisper oft verhört
// und die der Längen-Heuristik unten durchrutschen würden.
const STT_CORE = [
  'Backbord', 'Steuerbord', 'Luv', 'Lee', 'Bug', 'Heck', 'Kiel', 'Rumpf', 'Pinne', 'Ruder',
  'Fock', 'Genua', 'Halse', 'Wende', 'reffen', 'anluven', 'abfallen', 'Kimm', 'Bö', 'Tide',
  'Ebbe', 'Flut', 'KVR', 'Peilung', 'Betonnung', 'Anker', 'Törn',
];

// Umfassendes Fachglossar aus dem Fragenkatalog (Substring-Match, daher Grundformen –
// "Steuerbord" trifft auch "Steuerbordseite"/"Steuerbords" usw.). Wird NICHT komplett
// gesendet, sondern dient als Trefferliste: pro Frage gehen nur die hier bekannten Begriffe
// mit, die im Fragen-/Antworttext vorkommen (siehe buildSttPrompt).
const STT_GLOSSARY = [
  // Navigation & Seekarte
  'Seekarte', 'Fahrwasser', 'Fahrwasserachse', 'Untiefe', 'Kreuzpeilung', 'Deckpeilung',
  'Kompasspeilung', 'Standlinie', 'Kurslinie', 'Koppelnavigation', 'Besteckversetzung',
  'Beschickung', 'Missweisung', 'Deviation', 'Ablenkung', 'Ablenkungstabelle', 'Steuertafel',
  'Fehlweisung', 'Magnetkompass', 'Kugelkompass', 'Kompassnadel', 'Kartennull', 'Kartentiefe',
  'Kartendatum', 'Kartenbezugssystem', 'Seehandbuch', 'Leuchtfeuerverzeichnis', 'Erdkrümmung',
  'Augeshöhe', 'Fehlerkreis', 'Positionsbestimmung', 'Ortsbestimmung', 'Koordinaten', 'Basislinie',
  'Küstenmeer', 'Hoheitsgewässer', 'Wirtschaftszone', 'Seemeile', 'Kartennullebene',
  // Betonnung & Feuer
  'Lateralzeichen', 'Kardinalzeichen', 'Steuerbordtonne', 'Backbordtonne', 'Fasstonne',
  'Spierentonne', 'Leuchttonne', 'Großtonne', 'Bake', 'Pricke', 'Sonderzeichen', 'Schifffahrtszeichen',
  'Leuchtfeuer', 'Sektorenfeuer', 'Quermarkenfeuer', 'Oberfeuer', 'Unterfeuer', 'Leitfeuer',
  'Feuerhöhe', 'Kennung', 'Nenntragweite', 'Tragweite', 'Warnsektor', 'Sektorengrenze',
  'Befeuerung', 'Radarreflektor', 'Radartransponder', 'Markierungsblitzboje', 'Feuerschiff',
  // KVR & Verkehr
  'Kollisionsverhütungsregeln', 'SeeSchStrO', 'Ausweichregel', 'Ausweichpflicht', 'Ausweichmanöver',
  'Wegerecht', 'Wartepflicht', 'Kurshalter', 'Kurshaltepflicht', 'Vorfahrt', 'Verkehrstrennungsgebiet',
  'Trennzone', 'Trennlinie', 'Einbahnweg', 'Küstenverkehrszone', 'Verkehrszentrale', 'Passierseite',
  'Insichtkommen', 'Zusammenstoß', 'Kollisionsgefahr', 'Passierbehinderung',
  // Lichter, Signale & Fahrzeugarten
  'Lichterführung', 'Topplicht', 'Hecklicht', 'Seitenlicht', 'Steuerbordlicht', 'Backbordlicht',
  'Rundumlicht', 'Ankerlicht', 'Schlepplicht', 'Fahrtlichter', 'Schallsignal', 'Nebelsignal',
  'Signalkörper', 'Glockenschläge', 'Motoryacht', 'Maschinenfahrzeug', 'manövrierbehindert',
  'manövrierunfähig', 'Segelfahrzeug', 'Sportfahrzeug', 'Minenräumfahrzeug', 'Schleppverband',
  'Schlepptrosse', 'Tonnenleger', 'Kabelleger', 'Vermessungsfahrzeug', 'Rohrleger',
  // Segel & Rigg
  'Großsegel', 'Großbaum', 'Großschot', 'Vorsegel', 'Sturmfock', 'Rollfock', 'Spinnaker', 'Reff',
  'reffen', 'Reffleine', 'Reffkausch', 'Reffbändsel', 'Unterliek', 'Achterliek', 'Vorliek',
  'Unterliekstrecker', 'Vorliekstrecker', 'Cunningham', 'Baumniederholer', 'Traveller', 'Holepunkt',
  'Schothorn', 'Wanten', 'Achterstag', 'Vorstag', 'Abstag', 'Achterstagsspannung', 'Saling',
  'Takelung', 'Besegelung', 'Segeldruckpunkt', 'Lateralplan', 'Krängung', 'Luvgierigkeit',
  'anluven', 'abfallen', 'Schwerwettersegel',
  // Manöver, Ankern & Antrieb
  'ankern', 'Ankerkette', 'Ankertrosse', 'Ankerleine', 'Ankergrund', 'Ankerplatz', 'Schwojen',
  'Schwojraum', 'Reitgewicht', 'Treibanker', 'Kettenvorlauf', 'Haltekraft', 'Festmacherleine',
  'Vorspring', 'Achterspring', 'Vorleine', 'Achterleine', 'Wurfleine', 'Verwarpen', 'Drehkreis',
  'Stoppstrecke', 'Bugstrahlruder', 'Ruderlage', 'Hartruderlage', 'Querschub', 'Propeller',
  'Saildrive', 'Impeller', 'Bilgenpumpe', 'Lenzpumpe',
  // Gezeiten & Strom
  'Gezeiten', 'Tidenhub', 'Tidengewässer', 'Niedrigwasser', 'Hochwasser', 'Springzeit', 'Nippzeit',
  'Springtide', 'Nipptide', 'Stromkenterung', 'Gezeitenstrom', 'Gezeitentafel', 'Gezeitenstromatlas',
  'Gezeitenstromtabelle', 'Stauwasser', 'Wasserstand', 'Kentern',
  // Wetter
  'Seewetterbericht', 'Beaufort', 'Beaufortskala', 'Windstärke', 'Böigkeit', 'Kaltfront', 'Warmfront',
  'Okklusion', 'Okklusionsfront', 'Luftmassengrenze', 'Isobaren', 'Tiefdruckgebiet', 'Hochdruckgebiet',
  'Bodentief', 'Druckgefälle', 'Taupunkt', 'Taubildung', 'Kondensation', 'Cumulonimbus', 'Altocumulus',
  'Cirrostratus', 'Haufenwolke', 'Gewitterwolke', 'Düseneffekt', 'Fallwind', 'Seewind', 'Landwind',
  'Windverdriftung', 'Winddrehung', 'rückdrehend', 'rechtdrehend', 'Anemometer', 'Saharastaub',
  // Funk & Elektronik
  'UKW-Seefunk', 'Sprechfunk', 'DSC', 'Rufzeichen', 'MMSI', 'AIS', 'Radar', 'Radarecho',
  'Radarschatten', 'Seegangsclutter', 'DGPS', 'Satellitennavigation', 'Referenzstation',
  'Seenotfunkbake', 'Handsprechfunkgerät', 'Jachtfunkdienst', 'Seefunkanlage', 'Küstenfunkstelle',
  // Sicherheit & Notfall
  'Seenotsignal', 'Seenotsignalmittel', 'Fallschirmrakete', 'Handfackel', 'Rauchsignal',
  'Rettungsinsel', 'Rettungsfloß', 'Rettungsweste', 'Lifebelt', 'Sicherheitsgurt', 'Bergegurt',
  'Karabinerhaken', 'Trittschlinge', 'Rettungsschlinge', 'Rettungstalje', 'Lecksuche', 'Leckstelle',
  'Feuerlöscher', 'Pulverlöscher', 'Löschdecke', 'Seeventil', 'Überbordfallen', 'Überbordgefallene',
  // Recht, Umwelt & Dokumente
  'MARPOL', 'Seeschifffahrtsstraße', 'Binnenwasserstraße', 'Seeschifffahrtsstraßen-Ordnung',
  'Nachrichten für Seefahrer', 'Bekanntmachungen für Seefahrer', 'Berichtigung', 'Befähigungszeugnis',
  'Schiffszertifikat', 'Bundesflagge', 'Seeamt', 'Seeunfalluntersuchung', 'Meeresumwelt', 'Schiffsmüll',
  'Sondergebiet', 'Promille', 'Serviceplakette',
  // Rumpf & Stabilität
  'Formschwerpunkt', 'Massenschwerpunkt', 'Gewichtskraft', 'Auftriebskraft', 'Hebelarm', 'Stabilität',
  'Tiefgang', 'Rumpflänge', 'Beladungszustand', 'Zinkanode', 'Elektrolyse', 'Korrosion',
  // Sonstiges
  'Echolot', 'Handlot', 'Lotung', 'Logge', 'Keilriemen',
];

// Häufige, harmlose Großschreibungen, die die Heuristik NICHT als Fachbegriff werten soll.
const STT_STOP = new Set(['welche', 'warum', 'nennen', 'beschreiben', 'erklären', 'bedeutung',
  'maßnahmen', 'möglichkeiten', 'voraussetzungen', 'unterschiede', 'informationen', 'bestimmungen',
  'veränderungen', 'sicherheit', 'geschwindigkeit', 'entfernung', 'begründung', 'außerhalb']);

// Baut den Whisper-Kontext für EINE Frage:
//  - Kern (STT_CORE) immer dabei, steht vorn (wird zuerst gekürzt, falls nötig)
//  - Glossar-Begriffe, die in dieser Frage/Antwort vorkommen, + lange Komposita aus der Antwort
//    (heuristisch) + eigene Begriffe + Frage-Keywords ans ENDE (Whisper gewichtet das Ende stärker)
//  - aufs ~224-Token-Budget getrimmt, von vorne, damit das Fragen-spezifische erhalten bleibt.
function buildSttPrompt(q) {
  const kws = (q && Array.isArray(q.keywords)) ? q.keywords : [];
  const custom = (settings.sttPrompt || '').split(',').map(s => s.trim()).filter(Boolean);
  const hay = ((q && q.question || '') + ' ' + (q && q.answer || '') + ' ' + kws.join(' ')).toLowerCase();
  const relevant = STT_GLOSSARY.filter(t => hay.includes(t.toLowerCase()));
  // Lange, großgeschriebene Wörter aus der Antwort (Komposita, die das Glossar evtl. nicht kennt)
  const fromAnswer = [];
  const seenLong = new Set();
  for (const w of ((q && q.answer) || '').match(/[A-ZÄÖÜ][a-zäöüß]{7,}/g) || []) {
    const k = w.toLowerCase();
    if (!STT_STOP.has(k) && !seenLong.has(k)) { seenLong.add(k); fromAnswer.push(w); }
  }
  const all = [...STT_CORE, ...relevant, ...fromAnswer, ...custom, ...kws];
  const seen = new Set();
  const ordered = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const k = all[i].toLowerCase();
    if (!seen.has(k)) { seen.add(k); ordered.unshift(all[i]); }
  }
  const prefix = 'Segeln und Seefahrt, SKS-Theorieprüfung. Fachbegriffe: ';
  const MAX = 560; // Zeichen fürs Term-Segment (bleibt sicher unter 224 Tokens)
  while (ordered.length && (prefix + ordered.join(', ')).length > MAX) ordered.shift();
  return prefix + ordered.join(', ') + '.';
}

async function transcribe(blob, contextQ) {
  const base = apiBase();
  if (!base) throw new Error('Keine API-URL konfiguriert.');
  const fd = new FormData();
  fd.append('file', blob, 'audio.webm');
  fd.append('model', settings.sttModel);
  fd.append('language', 'de');
  fd.append('prompt', buildSttPrompt(contextQ));
  const res = await fetch(base + '/audio/transcriptions', { method: 'POST', headers: authHeaders(), body: fd });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Transkription fehlgeschlagen (${res.status}). ${t.slice(0, 200)}`); }
  const data = await res.json().catch(() => null);
  return (data && (data.text ?? data.transcript)) || '';
}

// ---------- TTS-Audio-Cache (IndexedDB, hält mp3-Blobs offline vor) ----------
const TTS_DB = 'sks.tts', TTS_STORE = 'audio', TTS_DB_VER = 1;
let ttsDbPromise = null;
function ttsDb() {
  if (ttsDbPromise) return ttsDbPromise;
  ttsDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(TTS_DB, TTS_DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TTS_STORE)) db.createObjectStore(TTS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);   // IndexedDB nicht verfügbar -> Cache stumm deaktiviert
  return ttsDbPromise;
}
// Key bindet Modell + Stimme ein, damit ein Wechsel nicht alte Audios liefert.
function ttsKey(text) { return `${settings.ttsModel} ${settings.ttsVoice} ${text}`; }
async function ttsCacheGet(key) {
  const db = await ttsDb();
  if (!db) return null;
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(TTS_STORE, 'readonly').objectStore(TTS_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}
async function ttsCachePut(key, blob) {
  const db = await ttsDb();
  if (!db) return;
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TTS_STORE, 'readwrite');
      tx.objectStore(TTS_STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* best effort */ }
}
async function ttsCacheClear() {
  const db = await ttsDb();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction(TTS_STORE, 'readwrite');
    tx.objectStore(TTS_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

let currentAudio = null, currentUrl = null;
function playBlob(blob) {
  if (currentAudio) currentAudio.pause();
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(blob);
  currentAudio = new Audio(currentUrl);
  currentAudio.play().catch(() => {});
}
async function speak(text) {
  const base = apiBase();
  if (!base || !settings.ttsEnabled || !text) return;
  const key = ttsKey(text);
  const cached = await ttsCacheGet(key);
  if (cached) { playBlob(cached); return; }   // Treffer: sofort aus dem Cache
  try {
    const res = await fetch(base + '/audio/speech', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: settings.ttsModel, input: text, voice: settings.ttsVoice, response_format: 'mp3' }),
    });
    if (!res.ok) return;
    const buf = await res.blob();
    ttsCachePut(key, buf);   // fürs nächste Mal ablegen (fire-and-forget)
    playBlob(buf);
  } catch { /* still */ }
}

// ---------- Audio recording ----------
let mediaRecorder = null, chunks = [], recStream = null;
async function startRecording() {
  recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
    : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
  mediaRecorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  chunks = [];
  mediaRecorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  mediaRecorder.start();
}
function stopRecording() {
  return new Promise(resolve => {
    if (!mediaRecorder) return resolve(null);
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
      recStream?.getTracks().forEach(t => t.stop());
      mediaRecorder = null; recStream = null;
      resolve(blob);
    };
    mediaRecorder.stop();
  });
}

// ---------- Helpers ----------
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fbLabel(q) { return `Fragebogen ${q.fragebogen} · Frage ${q.number}`; }
let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function imgTag(fn) { return `<div class="qimg"><img loading="lazy" src="img/${esc(fn)}" alt="Skizze"></div>`; }

// Zerlegt Text in {lead, items} falls eine 1.,2.,3.-Sequenz vorliegt, sonst null.
function toListParts(text) {
  const re = /(^|\s)(\d+)[.)]\s+/g;
  const marks = []; let m;
  while ((m = re.exec(text))) marks.push({ num: parseInt(m[2], 10), at: m.index + m[1].length, contentStart: re.lastIndex });
  const seq = []; let expected = 1;
  for (const p of marks) if (p.num === expected) { seq.push(p); expected++; }
  if (seq.length < 2) return null;
  const lead = text.slice(0, seq[0].at).trim();
  const items = seq.map((p, i) => text.slice(p.contentStart, (i + 1 < seq.length ? seq[i + 1].at : text.length)).trim());
  return { lead, items };
}
// Frage (Plaintext) als HTML mit ggf. nummerierter Liste.
function formatQuestion(text) {
  const parts = toListParts(text);
  if (!parts) return esc(text);
  return (parts.lead ? `<p class="lead">${esc(parts.lead)}</p>` : '') +
    `<ol class="qlist">${parts.items.map(i => `<li>${esc(i)}</li>`).join('')}</ol>`;
}
// Antwort-HTML (mit <strong>) als Liste, falls alle <br>-Segmente mit N. beginnen.
function formatAnswerHtml(html) {
  const segs = html.split('<br>').map(s => s.trim()).filter(Boolean);
  const marker = /^(?:<strong>)?\s*\d+[.)]\s+/;
  if (segs.length > 1 && segs.every(s => marker.test(s))) {
    const items = segs.map(s => s.replace(/^(<strong>)?\s*\d+[.)]\s+/, '$1'));
    return `<ol class="alist">${items.map(i => `<li>${i}</li>`).join('')}</ol>`;
  }
  return html;
}

// ---------- Views ----------
const view = () => $('#view');
let currentQ = null;
let activeQuestion = null;   // aktuell angezeigte Frage (Lern- oder Prüfungsmodus) für STT-Kontext

function needsConfig() { return !settings.apiKey || !apiBase(); }

function renderHome() {
  stopExamTimer();
  $('#subtitle').textContent = 'Lernmodus';
  currentQ = pickNext();
  if (!currentQ) {
    view().innerHTML = `<div class="empty"><div class="big">🎉</div>
      <p>Keine Fragen im aktuellen Filter.</p>
      <button class="btn primary" id="toStats">Statistik ansehen</button></div>`;
    $('#toStats').onclick = renderStats;
    return;
  }
  const q = currentQ;
  const rec = progress[q.id];
  const statusBadge = rec && rec.seen
    ? (rec.box >= 4 ? '<span class="badge soft">gemeistert</span>'
      : (rec.last === 'wrong' ? '<span class="badge" style="background:var(--err)">Wiederholung</span>'
        : `<span class="badge soft">Level ${rec.box}</span>`))
    : '<span class="badge soft">neu</span>';
  const qImgs = q.question_images.map(imgTag).join('');
  const configWarn = needsConfig()
    ? `<div class="result partial" style="margin-top:0;margin-bottom:12px">⚠️ API nicht konfiguriert — <a class="link" id="cfg">Einstellungen öffnen</a>. Ohne Konfiguration keine KI-Bewertung/Sprache.</div>` : '';
  view().innerHTML = `
    ${configWarn}
    <div class="card">
      <div class="qmeta">
        <span class="badge">${esc(fbLabel(q))}</span>
        ${statusBadge}
        <span class="spacer"></span>
        <button class="iconbtn" id="readBtn" title="Vorlesen" style="background:var(--surface-2);color:var(--brand-2)">🔊</button>
      </div>
      <div class="qtext">${formatQuestion(q.question)}</div>
      ${qImgs}
    </div>
    <div class="card" id="answerCard">
      <textarea class="answer" id="answer" placeholder="Deine Antwort … (tippen oder Mikrofon nutzen)"></textarea>
      <div class="inputbar">
        <button class="btn micbtn" id="micBtn" title="Sprechen">🎙️</button>
        <button class="btn primary" id="submitBtn">Antwort prüfen</button>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn ghost small" id="skipBtn">Überspringen</button>
        <span class="spacer"></span>
        <button class="btn ghost small" id="revealBtn">Lösung zeigen</button>
      </div>
    </div>
    <div id="resultArea"></div>`;

  if ($('#cfg')) $('#cfg').onclick = renderSettings;
  $('#readBtn').onclick = () => { if (!settings.ttsEnabled) { toast('Vorlesen in Einstellungen aktivieren'); return; } speak(q.question); };
  $('#submitBtn').onclick = onSubmit;
  $('#skipBtn').onclick = renderHome;
  $('#revealBtn').onclick = () => showModelAnswer(null);
  activeQuestion = q;
  $('#micBtn').onclick = onMic;
  if (settings.autoRead && settings.ttsEnabled) speak(q.question);
}

let recording = false;
async function onMic() {
  if (!settings.sttEnabled) { toast('Spracheingabe in Einstellungen aktivieren'); return; }
  if (needsConfig()) { toast('Erst API konfigurieren'); return; }
  const btn = $('#micBtn');
  if (!recording) {
    try { await startRecording(); recording = true; btn.classList.add('recording'); btn.textContent = '⏹️'; toast('Aufnahme läuft … erneut tippen zum Stoppen'); }
    catch (e) { toast('Mikrofon nicht verfügbar: ' + e.message); }
  } else {
    recording = false; btn.classList.remove('recording'); btn.textContent = '🎙️';
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      const blob = await stopRecording();
      const text = await transcribe(blob, activeQuestion);
      const ta = $('#answer');
      ta.value = (ta.value ? ta.value.trim() + ' ' : '') + text;
      ta.focus();
    } catch (e) { toast(e.message); }
    btn.innerHTML = '🎙️';
  }
}

async function onSubmit() {
  const ta = $('#answer'); const ans = ta.value.trim();
  if (!ans) { toast('Bitte zuerst eine Antwort eingeben'); return; }
  if (needsConfig()) { toast('API nicht konfiguriert'); renderSettings(); return; }
  const btn = $('#submitBtn'); btn.disabled = true; const orig = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span> Bewerte …';
  try {
    const result = await gradeAnswer(currentQ, ans);
    applyResult(currentQ.id, result.verdict);
    showModelAnswer(result);
  } catch (e) {
    toast(e.message);
    btn.disabled = false; btn.textContent = orig;
  }
}

function keywordChips(result) {
  const kws = currentQ.keywords || [];
  if (!kws.length) return '';
  const matched = new Set((result?.matched_keywords || []).map(k => k.toLowerCase()));
  const chips = kws.map(k => {
    const hit = result ? [...matched].some(m => m.includes(k.toLowerCase()) || k.toLowerCase().includes(m)) : false;
    const cls = result ? (hit ? 'hit' : 'miss') : '';
    return `<span class="kw ${cls}">${esc(k)}</span>`;
  }).join('');
  return `<div class="small muted" style="margin-top:12px">Schlüsselwörter${result ? ' (✓ getroffen / ✗ fehlend)' : ''}:</div><div class="kwlist">${chips}</div>`;
}

function showModelAnswer(result) {
  const q = currentQ;
  const aImgs = q.answer_images.map(imgTag).join('');
  let resultHtml = '';
  if (result) {
    const labels = { correct: '✅ Richtig', partial: '🟡 Teilweise richtig', wrong: '❌ Nicht ausreichend' };
    resultHtml = `
      <div class="result ${result.verdict}">
        <div class="verdict">${labels[result.verdict]} <span class="spacer"></span><span class="small">${result.score}%</span></div>
        <div class="scorebar"><i style="width:${result.score}%"></i></div>
        ${result.feedback ? `<div class="fb">${esc(result.feedback)}</div>` : ''}
      </div>`;
  }
  // "Lösung zeigen" umgeht die eigene Antwort -> keine Wertung, nur Musterantwort + Weiter.
  const graded = !!result;   // per KI bewertet? sonst reine Selbstkontrolle ("Lösung zeigen")
  const markHtml = graded ? `
    <div class="mark-row">
      <button class="btn ok${result.verdict === 'correct' ? ' active' : ''}" id="markRight">✓ Als richtig werten</button>
      <button class="btn bad${result.verdict === 'wrong' ? ' active' : ''}" id="markWrong">✗ Als falsch werten</button>
    </div>
    <div class="small muted center" id="markHint" style="margin-top:6px">Vorauswahl aus der KI-Wertung — bei Bedarf selbst anpassen (zählt für den Lernfortschritt).</div>` : '';

  view().querySelector('#resultArea').innerHTML = `
    ${resultHtml}
    <div class="model-answer">
      <div class="small muted" style="margin-bottom:6px">Musterantwort</div>
      <div>${formatAnswerHtml(q.answer_html || esc(q.answer))}</div>
      ${aImgs}
      ${keywordChips(result)}
    </div>
    ${markHtml}
    <button class="btn primary block" id="nextBtn" style="margin-top:14px">Nächste Frage →</button>`;

  if (graded) {
    // Eingabebereich sperren (Antwort bleibt zum Vergleich sichtbar)
    const sub = $('#submitBtn'); if (sub) { sub.disabled = true; sub.textContent = 'Geprüft'; }
    const mic = $('#micBtn'); if (mic) mic.disabled = true;

    const markManual = (verdict, label) => {
      overrideResult(currentQ.id, verdict);
      const mr = $('#markRight'), mw = $('#markWrong');
      mr.classList.toggle('active', verdict === 'correct');
      mw.classList.toggle('active', verdict === 'wrong');
      $('#markHint').textContent = label + ' — im Lernfortschritt übernommen.';
      toast(label);
    };
    $('#markRight').onclick = () => markManual('correct', 'Als richtig gewertet');
    $('#markWrong').onclick = () => markManual('wrong', 'Als falsch gewertet');
  } else {
    // Antwort-Fenster ganz ausblenden — nur Frage, Musterantwort und Weiter-Knopf.
    const ac = $('#answerCard'); if (ac) ac.style.display = 'none';
  }

  $('#nextBtn').onclick = renderHome;
  $('#resultArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (settings.autoRead && settings.ttsEnabled) speak(q.answer);
}

function renderStats() {
  stopExamTimer();
  $('#subtitle').textContent = 'Statistik';
  const total = QUESTIONS.length;
  const isRight = id => progress[id] && progress[id].last === 'correct';
  const isMasteredQ = id => progress[id] && progress[id].box >= 4;   // 4× richtig in Folge
  let seen = 0, right = 0, due = 0, mastered = 0;
  for (const q of QUESTIONS) {
    const r = progress[q.id];
    if (r && r.seen) { seen++; if (r.last === 'correct') { right++; if (r.box >= 4) mastered++; } else due++; }
  }
  const pct = total ? Math.round(right / total * 100) : 0;
  // per-Fragebogen: Anteil zuletzt richtig beantworteter Fragen
  const perFb = INDEX.fragebogen.map(f => {
    const qs = QUESTIONS.filter(q => q.fragebogen === f.fragebogen);
    const r = qs.filter(q => isRight(q.id)).length;
    return { fb: f.fragebogen, total: qs.length, right: r, pct: Math.round(r / qs.length * 100) };
  });
  view().innerHTML = `
    <div class="card">
      <h2>Gesamtfortschritt</h2>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="small muted">${right} von ${total} Fragen richtig beantwortet (${pct}%) · davon ${mastered} sicher gemeistert (4× richtig)</div>
      <div class="stat-grid" style="margin-top:14px">
        <div class="stat"><div class="num">${seen}</div><div class="lbl">gesehen</div></div>
        <div class="stat"><div class="num" style="color:var(--ok)">${right}</div><div class="lbl">richtig</div></div>
        <div class="stat"><div class="num" style="color:var(--warn)">${due}</div><div class="lbl">zu üben</div></div>
      </div>
    </div>
    <div class="card">
      <h2>Nach Fragebogen</h2>
      ${perFb.map(f => `<div class="fb-row">
        <div class="name">Fragebogen ${f.fb}</div>
        <div class="progress"><i style="width:${f.pct}%"></i></div>
        <div class="pct">${f.pct}%</div>
      </div>`).join('')}
    </div>
    <div class="card">
      <button class="btn block" id="resetBtn">Fortschritt zurücksetzen</button>
    </div>`;
  $('#resetBtn').onclick = () => {
    if (confirm('Gesamten Lernfortschritt wirklich löschen?')) {
      progress = {}; saveProgress(progress); toast('Fortschritt zurückgesetzt'); renderStats();
    }
  };
}

function renderSettings() {
  stopExamTimer();
  $('#subtitle').textContent = 'Einstellungen';
  const fbChips = INDEX.fragebogen.map(f => {
    const active = settings.scope !== 'all' && Array.isArray(settings.scope) && settings.scope.includes(f.fragebogen);
    return `<button class="chip ${active ? 'active' : ''}" data-fb="${f.fragebogen}">${f.fragebogen}</button>`;
  }).join('');
  const allActive = settings.scope === 'all';
  view().innerHTML = `
    <div class="card">
      <h2>KI-Verbindung</h2>
      <label class="field"><span>API-URL (OpenAI-kompatibel)</span>
        <input type="url" id="apiUrl" value="${esc(settings.apiUrl)}" placeholder="https://llm.croit.io/v1"></label>
      <label class="field"><span>API-Schlüssel (PAT)</span>
        <input type="password" id="apiKey" value="${esc(settings.apiKey)}" placeholder="sk-… / PAT" autocomplete="off"></label>
      <label class="field"><span>Chat-Modell</span>
        <input type="text" id="model" value="${esc(settings.model)}" placeholder="qwen"></label>
      <div class="switch"><span>Thinking abschalten (Reasoning-Modelle wie Qwen3)</span>
        <label class="toggle"><input type="checkbox" id="disableThinking" ${settings.disableThinking ? 'checked' : ''}><span class="slider"></span></label></div>
      <button class="btn block" id="testBtn">Verbindung testen</button>
      <div class="small muted" style="margin-top:8px">Schlüssel & URL werden nur lokal im Browser (localStorage) gespeichert.</div>
    </div>
    <div class="card">
      <h2>Sprache</h2>
      <div class="switch"><span>Spracheingabe (Mikrofon → KI-Transkription)</span>
        <label class="toggle"><input type="checkbox" id="sttEnabled" ${settings.sttEnabled ? 'checked' : ''}><span class="slider"></span></label></div>
      <label class="field"><span>STT-Modell</span><input type="text" id="sttModel" value="${esc(settings.sttModel)}" placeholder="whisper-1"></label>
      <label class="field"><span>Eigene Fachbegriffe (Komma-getrennt)</span>
        <textarea id="sttPrompt" rows="2" placeholder="z. B. Quermarkenfeuer, Kardinaltonne, Nipptide">${esc(settings.sttPrompt)}</textarea></label>
      <div class="small muted" style="margin-top:4px">Hilft der Spracherkennung bei Bootsbegriffen. Die Schlüsselwörter der aktuellen Frage werden automatisch ergänzt.</div>
      <div class="switch"><span>Vorlesen (KI-Stimme, TTS)</span>
        <label class="toggle"><input type="checkbox" id="ttsEnabled" ${settings.ttsEnabled ? 'checked' : ''}><span class="slider"></span></label></div>
      <label class="field"><span>TTS-Modell</span><input type="text" id="ttsModel" value="${esc(settings.ttsModel)}" placeholder="tts-1"></label>
      <label class="field"><span>TTS-Stimme</span><input type="text" id="ttsVoice" value="${esc(settings.ttsVoice)}" placeholder="alloy"></label>
      <div class="switch"><span>Frage & Lösung automatisch vorlesen</span>
        <label class="toggle"><input type="checkbox" id="autoRead" ${settings.autoRead ? 'checked' : ''}><span class="slider"></span></label></div>
      <button class="btn block" id="clearTtsBtn" style="margin-top:8px">Sprach-Cache leeren</button>
      <div class="small muted" style="margin-top:8px">Vorgelesene Antworten werden lokal gespeichert und beim nächsten Mal sofort abgespielt.</div>
    </div>
    <div class="card">
      <h2>Lernmodus</h2>
      <label class="field"><span>Auswahlstrategie</span>
        <select id="mode">
          <option value="smart" ${settings.mode === 'smart' ? 'selected' : ''}>Smart (Fehler priorisiert)</option>
          <option value="new" ${settings.mode === 'new' ? 'selected' : ''}>Nur neue Fragen</option>
          <option value="wrong" ${settings.mode === 'wrong' ? 'selected' : ''}>Nur Problemfragen</option>
          <option value="sequential" ${settings.mode === 'sequential' ? 'selected' : ''}>Der Reihe nach</option>
        </select></label>
      <div class="field"><span>Fragebögen</span>
        <div class="chips" style="margin-top:6px">
          <button class="chip ${allActive ? 'active' : ''}" data-fb="all">Alle</button>
          ${fbChips}
        </div>
      </div>
    </div>`;

  const collect = () => {
    settings.apiUrl = $('#apiUrl').value.trim();
    settings.apiKey = $('#apiKey').value.trim();
    settings.model = $('#model').value.trim() || 'qwen';
    settings.disableThinking = $('#disableThinking').checked;
    settings.sttEnabled = $('#sttEnabled').checked;
    settings.sttModel = $('#sttModel').value.trim() || 'whisper-1';
    settings.sttPrompt = $('#sttPrompt').value.trim();
    settings.ttsEnabled = $('#ttsEnabled').checked;
    settings.ttsModel = $('#ttsModel').value.trim() || 'tts-1';
    settings.ttsVoice = $('#ttsVoice').value.trim() || 'alloy';
    settings.autoRead = $('#autoRead').checked;
    settings.mode = $('#mode').value;
    saveSettings(settings);
  };
  // live speichern
  $$('#view input, #view select, #view textarea').forEach(el => el.addEventListener('change', collect));

  // Fragebogen-Chips
  $$('#view .chip').forEach(chip => chip.onclick = () => {
    const v = chip.dataset.fb;
    if (v === 'all') { settings.scope = 'all'; }
    else {
      const n = Number(v);
      let arr = (settings.scope === 'all' || !Array.isArray(settings.scope)) ? [] : [...settings.scope];
      if (arr.includes(n)) arr = arr.filter(x => x !== n); else arr.push(n);
      settings.scope = arr.length ? arr : 'all';
    }
    saveSettings(settings);
    renderSettings();
  });

  $('#clearTtsBtn').onclick = async () => {
    const btn = $('#clearTtsBtn'); btn.disabled = true;
    await ttsCacheClear();
    btn.disabled = false;
    toast('Sprach-Cache geleert');
  };

  $('#testBtn').onclick = async () => {
    collect();
    const btn = $('#testBtn'); btn.disabled = true; btn.innerHTML = '<span class="spinner dark"></span> Teste …';
    try {
      const res = await fetch(apiBase() + '/chat/completions', {
        method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(buildChatBody([{ role: 'user', content: 'Sag OK' }], 512)),
      });
      if (res.ok) { const d = await res.json().catch(() => ({})); toast('✅ Verbindung OK · Modell: ' + (d.model || settings.model)); }
      else toast(`Fehler ${res.status}: ${(await res.text()).slice(0, 120)}`);
    } catch (e) { toast('Verbindungsfehler: ' + e.message + ' (evtl. CORS)'); }
    btn.disabled = false; btn.textContent = 'Verbindung testen';
  };
}

// ---------- Prüfungsmodus ----------
const EXAM_KEY = 'sks.exam';
const EXAM_DURATION_MS = 90 * 60 * 1000;   // 90 Minuten
const EXAM_PASS_PCT = 75;                  // Richtwert für "bestanden"
let exam = null;          // aktive Prüfung (im Speicher)
let examInterval = null;

function loadExam() { try { return JSON.parse(localStorage.getItem(EXAM_KEY) || 'null'); } catch { return null; } }
function saveExam() { if (exam) localStorage.setItem(EXAM_KEY, JSON.stringify(exam)); else localStorage.removeItem(EXAM_KEY); }
function examRemaining() { return exam ? Math.max(0, exam.startTs + exam.durationMs - Date.now()) : 0; }
function fmtClock(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function stopExamTimer() { if (examInterval) { clearInterval(examInterval); examInterval = null; } }

function startExam(fbNum) {
  const qs = QUESTIONS.filter(q => q.fragebogen === fbNum).sort((a, b) => a.number - b.number);
  exam = {
    fb: fbNum,
    order: qs.map(q => q.id),
    answers: {},               // qid -> Text
    results: null,             // nach Abgabe: qid -> {verdict,score,...}
    index: 0,
    startTs: Date.now(),
    durationMs: EXAM_DURATION_MS,
    finished: false,
  };
  saveExam();
  renderExamQuestion();
}

function renderExam() {
  // Einstieg: laufende Prüfung fortsetzen oder neue starten
  stopExamTimer();
  $('#subtitle').textContent = 'Prüfung';
  const saved = exam || loadExam();
  if (saved && !saved.finished && (saved.startTs + saved.durationMs - Date.now()) > 0) {
    exam = saved;
    view().innerHTML = `<div class="card center">
      <div class="big" style="font-size:34px">📝</div>
      <h2>Laufende Prüfung</h2>
      <p class="muted">Fragebogen ${exam.fb} · noch ${fmtClock(examRemaining())} · Frage ${exam.index + 1}/${exam.order.length}</p>
      <button class="btn primary block" id="resumeExam" style="margin-top:8px">Fortsetzen</button>
      <button class="btn ghost block" id="abortExam" style="margin-top:10px">Abbrechen &amp; verwerfen</button>
    </div>`;
    $('#resumeExam').onclick = renderExamQuestion;
    $('#abortExam').onclick = () => { exam = null; saveExam(); renderExam(); };
    return;
  }
  if (saved && saved.finished && saved.results) { exam = saved; return renderExamResults(); }

  const opts = INDEX.fragebogen.map(f => `<option value="${f.fragebogen}">Fragebogen ${f.fragebogen} (${f.count} Fragen)</option>`).join('');
  view().innerHTML = `
    <div class="card">
      <h2>📝 Prüfungsmodus</h2>
      <p class="muted small">Ein kompletter Fragebogen unter Prüfungsbedingungen: <strong>${EXAM_DURATION_MS / 60000} Minuten</strong>,
      alle Fragen der Reihe nach, Bewertung durch die KI am Ende. Kein Feedback zwischendurch.</p>
      <label class="field" style="margin-top:12px"><span>Fragebogen wählen</span>
        <select id="examFb">${opts}</select></label>
      <button class="btn primary block" id="startExam">Prüfung starten</button>
      ${needsConfig() ? '<div class="result partial" style="margin-top:12px">⚠️ API nicht konfiguriert — die Auswertung am Ende benötigt die KI.</div>' : ''}
    </div>`;
  $('#startExam').onclick = () => startExam(Number($('#examFb').value));
}

function renderExamQuestion() {
  stopExamTimer();
  $('#subtitle').textContent = 'Prüfung';
  if (!exam) return renderExam();
  if (examRemaining() <= 0) return finishExam(true);
  const qid = exam.order[exam.index];
  const q = QBY_ID.get(qid);
  const total = exam.order.length;
  const answered = exam.order.filter(id => (exam.answers[id] || '').trim()).length;
  const dots = exam.order.map((id, i) => {
    const cls = i === exam.index ? 'cur' : ((exam.answers[id] || '').trim() ? 'done' : '');
    return `<button class="qdot ${cls}" data-i="${i}">${i + 1}</button>`;
  }).join('');
  const qImgs = q.question_images.map(imgTag).join('');
  view().innerHTML = `
    <div class="exambar">
      <div class="timer" id="timer">⏱ ${fmtClock(examRemaining())}</div>
      <div class="spacer"></div>
      <div class="small muted">Frage ${exam.index + 1}/${total} · ${answered} beantwortet</div>
    </div>
    <div class="qnav">${dots}</div>
    <div class="card">
      <div class="qmeta"><span class="badge">Fragebogen ${exam.fb} · Frage ${q.number}</span></div>
      <div class="qtext">${formatQuestion(q.question)}</div>
      ${qImgs}
    </div>
    <div class="card">
      <textarea class="answer" id="answer" placeholder="Deine Antwort …">${esc(exam.answers[qid] || '')}</textarea>
      <div class="inputbar">
        <button class="btn micbtn" id="micBtn" title="Sprechen">🎙️</button>
        <button class="btn" id="prevBtn" ${exam.index === 0 ? 'disabled' : ''}>← Zurück</button>
        <button class="btn primary" id="nextBtn">${exam.index === total - 1 ? 'Zur Abgabe →' : 'Weiter →'}</button>
      </div>
      <button class="btn accent block" id="submitExam" style="margin-top:12px">Prüfung abgeben</button>
    </div>`;

  const saveCur = () => { exam.answers[qid] = $('#answer').value; saveExam(); };
  $('#answer').addEventListener('input', () => { exam.answers[qid] = $('#answer').value; });
  activeQuestion = q;
  $('#micBtn').onclick = onMic;
  $('#prevBtn').onclick = () => { saveCur(); if (exam.index > 0) { exam.index--; saveExam(); renderExamQuestion(); } };
  $('#nextBtn').onclick = () => { saveCur(); if (exam.index < total - 1) { exam.index++; saveExam(); renderExamQuestion(); } else renderExamSubmitPrompt(); };
  $('#submitExam').onclick = () => { saveCur(); renderExamSubmitPrompt(); };
  $$('#view .qdot').forEach(d => d.onclick = () => { saveCur(); exam.index = Number(d.dataset.i); saveExam(); renderExamQuestion(); });

  // Timer starten
  const tick = () => {
    const rem = examRemaining();
    const el = $('#timer');
    if (el) { el.textContent = '⏱ ' + fmtClock(rem); el.classList.toggle('warn', rem <= 5 * 60 * 1000); el.classList.toggle('crit', rem <= 60 * 1000); }
    if (rem <= 0) { stopExamTimer(); finishExam(true); }
  };
  examInterval = setInterval(tick, 1000);
}

function renderExamSubmitPrompt() {
  stopExamTimer();
  const total = exam.order.length;
  const answered = exam.order.filter(id => (exam.answers[id] || '').trim()).length;
  view().innerHTML = `<div class="card center">
    <div class="big" style="font-size:34px">✅</div>
    <h2>Prüfung abgeben?</h2>
    <p class="muted">${answered} von ${total} Fragen beantwortet · noch ${fmtClock(examRemaining())} übrig.</p>
    <p class="small muted">Nicht beantwortete Fragen zählen als falsch. Die KI bewertet danach alle Antworten.</p>
    <button class="btn primary block" id="doSubmit" style="margin-top:8px">Jetzt abgeben &amp; auswerten</button>
    <button class="btn ghost block" id="backExam" style="margin-top:10px">Zurück zur Prüfung</button>
  </div>`;
  $('#doSubmit').onclick = () => finishExam(false);
  $('#backExam').onclick = renderExamQuestion;
}

async function gradeWithRetry(q, ans, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await gradeAnswer(q, ans); }
    catch (e) { last = e; await new Promise(r => setTimeout(r, 500 * (i + 1))); }
  }
  return { verdict: 'error', score: 0, feedback: 'Bewertung fehlgeschlagen: ' + last.message, matched_keywords: [], missing_keywords: [] };
}

// Bewertet die angegebenen qids (Standard: alle) und schreibt in exam.results.
async function gradeExamQuestions(qids, progressLabel) {
  const total = qids.length;
  let done = 0;
  const ids = [...qids];
  const CONC = 3;
  const updateProg = () => { const pe = $('#gradeProg'); if (pe) pe.textContent = `${done}/${total}`; };
  async function worker() {
    while (ids.length) {
      const qid = ids.shift();
      const q = QBY_ID.get(qid);
      const ans = (exam.answers[qid] || '').trim();
      if (!ans) exam.results[qid] = { verdict: 'wrong', score: 0, feedback: 'Nicht beantwortet.', matched_keywords: [], missing_keywords: q.keywords };
      else exam.results[qid] = await gradeWithRetry(q, ans);
      done++; updateProg();
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, total) }, worker));
}

async function finishExam(timedOut) {
  stopExamTimer();
  if (!exam) return renderExam();
  const total = exam.order.length;
  view().innerHTML = `<div class="empty"><span class="spinner dark"></span>
    <p>${timedOut ? '⏰ Zeit abgelaufen. ' : ''}Werte Prüfung aus …</p>
    <p class="small muted" id="gradeProg">0/${total}</p></div>`;

  exam.results = {};
  await gradeExamQuestions(exam.order);
  // SRS aktualisieren (Prüfung zählt fürs Lernen); API-Fehler ausklammern
  for (const qid of exam.order) { const v = exam.results[qid].verdict; if (v !== 'error') applyResult(qid, v); }

  exam.finished = true;
  exam.usedMs = Math.min(exam.durationMs, Date.now() - exam.startTs);
  saveExam();
  renderExamResults();
}

async function regradeErrors() {
  const errored = exam.order.filter(qid => exam.results[qid]?.verdict === 'error');
  if (!errored.length) return;
  view().innerHTML = `<div class="empty"><span class="spinner dark"></span>
    <p>Werte fehlgeschlagene Fragen erneut aus …</p><p class="small muted" id="gradeProg">0/${errored.length}</p></div>`;
  await gradeExamQuestions(errored);
  for (const qid of errored) { const v = exam.results[qid].verdict; if (v !== 'error') applyResult(qid, v); }
  saveExam();
  renderExamResults();
}

function renderExamResults() {
  stopExamTimer();
  $('#subtitle').textContent = 'Prüfungsergebnis';
  const total = exam.order.length;
  const r = exam.results;
  let correct = 0, partial = 0, wrong = 0, errored = 0, points = 0;
  for (const qid of exam.order) {
    const v = r[qid].verdict;
    if (v === 'correct') { correct++; points += 1; }
    else if (v === 'partial') { partial++; points += 0.5; }
    else if (v === 'error') { errored++; }
    else wrong++;
  }
  const graded = total - errored;                       // Fehler nicht in die Wertung
  const pct = graded > 0 ? Math.round(points / graded * 100) : 0;
  const passed = errored === 0 && pct >= EXAM_PASS_PCT;
  const errBanner = errored
    ? `<div class="result partial" style="margin-top:12px">⚠️ ${errored} Frage(n) konnten wegen API-Fehler nicht bewertet werden und sind aus der Wertung ausgeklammert.
       <button class="btn accent block" id="regradeBtn" style="margin-top:10px">Erneut auswerten</button></div>`
    : '';
  const rows = exam.order.map((qid, i) => {
    const q = QBY_ID.get(qid); const res = r[qid];
    const icon = res.verdict === 'correct' ? '✅' : (res.verdict === 'partial' ? '🟡' : (res.verdict === 'error' ? '⚠️' : '❌'));
    return `<details class="exrow ${res.verdict}">
      <summary><span class="ex-ic">${icon}</span> <span class="ex-n">${i + 1}.</span> <span class="ex-q">${esc(q.question).slice(0, 80)}${q.question.length > 80 ? '…' : ''}</span></summary>
      <div class="ex-body">
        <div class="small muted">Deine Antwort</div>
        <div>${(exam.answers[qid] || '').trim() ? esc(exam.answers[qid]) : '<em class="muted">— nicht beantwortet —</em>'}</div>
        ${res.feedback ? `<div class="small" style="margin-top:8px">${esc(res.feedback)}</div>` : ''}
        <div class="model-answer" style="margin-top:10px">
          <div class="small muted" style="margin-bottom:4px">Musterantwort</div>
          <div>${formatAnswerHtml(q.answer_html || esc(q.answer))}</div>
          ${q.answer_images.map(imgTag).join('')}
        </div>
      </div>
    </details>`;
  }).join('');

  view().innerHTML = `
    <div class="card center">
      <div class="badge ${passed ? '' : 'soft'}" style="${passed ? 'background:var(--ok)' : 'background:var(--err);color:#fff'}">${passed ? 'BESTANDEN' : 'NICHT BESTANDEN'} <span class="small">(Richtwert ≥${EXAM_PASS_PCT}%)</span></div>
      <div style="font-size:44px;font-weight:800;margin:10px 0 2px;color:var(--brand-2)">${pct}%</div>
      <div class="muted small">Fragebogen ${exam.fb} · Zeit ${fmtClock(exam.usedMs || 0)} von ${fmtClock(exam.durationMs)}${errored ? ' · Wertung aus ' + graded + '/' + total : ''}</div>
      <div class="stat-grid" style="margin-top:14px">
        <div class="stat"><div class="num" style="color:var(--ok)">${correct}</div><div class="lbl">richtig</div></div>
        <div class="stat"><div class="num" style="color:var(--warn)">${partial}</div><div class="lbl">teilweise</div></div>
        <div class="stat"><div class="num" style="color:var(--err)">${wrong}</div><div class="lbl">falsch</div></div>
      </div>
      ${errBanner}
      <button class="btn primary block" id="againExam" style="margin-top:14px">Neue Prüfung</button>
    </div>
    <div class="card">
      <h2>Auswertung im Detail</h2>
      ${rows}
    </div>`;
  $('#againExam').onclick = () => { exam = null; saveExam(); renderExam(); };
  if ($('#regradeBtn')) $('#regradeBtn').onclick = regradeErrors;
}

// ---------- Nav & init ----------
function initNav() {
  $('#navHome').onclick = () => { stopExamTimer(); renderHome(); };
  $('#navExam').onclick = renderExam;
  $('#navStats').onclick = () => { stopExamTimer(); renderStats(); };
  $('#navSettings').onclick = () => { stopExamTimer(); renderSettings(); };
}

async function init() {
  initNav();
  view().innerHTML = `<div class="empty"><span class="spinner dark"></span><p>Lade Fragen …</p></div>`;
  try {
    await loadData();
  } catch (e) {
    view().innerHTML = `<div class="empty"><div class="big">⚠️</div><p>Fragen konnten nicht geladen werden.<br>${esc(e.message)}</p><p class="small muted">Bitte über einen Webserver öffnen (nicht per file://).</p></div>`;
    return;
  }
  if (needsConfig()) renderSettings(); else renderHome();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();

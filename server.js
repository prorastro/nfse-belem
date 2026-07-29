// ============================================================
// Microserviço NFS-e Belém (padrão Nacional / ADN - RTC IBS/CBS)
// Recebe dados da nota -> monta DPS -> assina (XMLDSIG) ->
// gzip -> base64 -> POST mTLS -> devolve NFS-e descompactada.
// Roda ao lado do n8n. O certificado NUNCA sai deste servidor.
// ============================================================
const fs = require('fs');
const zlib = require('zlib');
const https = require('https');
const express = require('express');
const { SignedXml } = require('xml-crypto');
const forge = require('node-forge');
const { buildFromConfig } = require('./dps-builder');
const companyCfg = require('./company.config.json');

const {
  PORT = 3005,
  PFX_PATH,                 // caminho do .pfx A1
  PFX_PASS,                 // senha do .pfx
  ADN_URL = 'https://homol-nfse2.belem.pa.gov.br/notafiscal-adn-ws/api/adn/dps',
  API_TOKEN,                // token simples para proteger este serviço (header x-token)
  ADN_TIMEOUT_MS = 60000,   // timeout da chamada à prefeitura (evita travar)
  TLS_INSECURE,             // '1' desativa validação da cadeia TLS (só p/ depurar homolog.)
} = process.env;

// ---- carrega certificado de forma resiliente (não derruba o container) ----
let agent = null;      // agente mTLS
let keyPem = null;     // chave privada p/ assinar
let certB64 = null;    // certificado base64 p/ KeyInfo
let certErro = null;   // guarda erro de carga p/ diagnosticar via /health

function carregarCertificado() {
  try {
    if (!PFX_PATH) throw new Error('PFX_PATH não definido');
    if (!fs.existsSync(PFX_PATH)) throw new Error(`arquivo não encontrado: ${PFX_PATH}`);
    const pfx = fs.readFileSync(PFX_PATH);

    const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, PFX_PASS);
    let cPem;
    for (const sc of p12.safeContents) {
      for (const bag of sc.safeBags) {
        if (bag.key) keyPem = forge.pki.privateKeyToPem(bag.key);
        if (bag.cert && !cPem) cPem = forge.pki.certificateToPem(bag.cert);
      }
    }
    if (!keyPem || !cPem) throw new Error('não foi possível extrair chave/cert do .pfx (senha errada?)');
    certB64 = cPem.replace(/-----(BEGIN|END) CERTIFICATE-----|\r|\n/g, '');

    agent = new https.Agent({
      pfx, passphrase: PFX_PASS,
      rejectUnauthorized: TLS_INSECURE !== '1',
      keepAlive: true,
    });
    certErro = null;
    console.log('[cert] certificado carregado com sucesso');
  } catch (e) {
    certErro = e.message;
    console.error('[cert] FALHA ao carregar certificado:', e.message);
  }
}
carregarCertificado();

// ---- assina o XML da DPS (enveloped, RSA-SHA1, C14N, sem prefixo ds:) ----
function assinarDPS(xml, refId) {
  const sig = new SignedXml({ privateKey: keyPem });
  sig.signatureAlgorithm = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
  sig.canonicalizationAlgorithm = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
  sig.addReference({
    xpath: `//*[@Id='${refId}']`,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    ],
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    uri: `#${refId}`,
  });
  sig.getKeyInfoContent = () => `<X509Data><X509Certificate>${certB64}</X509Certificate></X509Data>`;
  sig.computeSignature(xml, {
    prefix: '',
    location: { reference: `//*[local-name()='infDPS']`, action: 'after' },
  });
  return sig.getSignedXml();
}

// ---- POST https nativo com agent mTLS + timeout (não trava) ----
function postNative(url, json) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(json));
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ''),
        method: 'POST',
        agent,
        timeout: Number(ADN_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      },
      (resp) => {
        let buf = '';
        resp.on('data', (c) => (buf += c));
        resp.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(buf || '{}'); }
          catch { parsed = { raw: buf.slice(0, 2000) }; }
          resolve({ status: resp.statusCode, body: parsed });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`timeout após ${ADN_TIMEOUT_MS}ms chamando a prefeitura`)));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// envia a DPS assinada e descompacta a resposta
async function enviarDPS(xmlAssinado) {
  const dpsXmlGZipB64 = zlib.gzipSync(Buffer.from(xmlAssinado, 'utf8')).toString('base64');
  const { status, body } = await postNative(ADN_URL, { dpsXmlGZipB64 });
  if (body && body.nfseXmlGZipB64) {
    try { body.nfseXml = zlib.gunzipSync(Buffer.from(body.nfseXmlGZipB64, 'base64')).toString('utf8'); }
    catch { /* mantém compactado se falhar */ }
  }
  return { status, body };
}

function checarToken(req, res) {
  if (API_TOKEN && req.headers['x-token'] !== API_TOKEN) {
    res.status(401).json({ error: 'token inválido' });
    return false;
  }
  if (!agent || !keyPem) {
    res.status(503).json({ error: 'certificado indisponível', detalhe: certErro, dica: 'verifique PFX_PATH/PFX_PASS e reinicie' });
    return false;
  }
  return true;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// health: 200 sempre que o processo está de pé; mostra status do certificado
app.get('/health', (_req, res) =>
  res.json({ ok: true, certificado: agent ? 'ok' : 'erro', certErro, ambiente: ADN_URL }));

// recarrega o certificado sem reiniciar o container (após trocar o .pfx)
app.post('/reload-cert', (req, res) => {
  if (API_TOKEN && req.headers['x-token'] !== API_TOKEN) return res.status(401).json({ error: 'token inválido' });
  carregarCertificado();
  res.json({ certificado: agent ? 'ok' : 'erro', certErro });
});

// POST /emitir  { dpsXml, refId }  — XML já montado externamente
app.post('/emitir', async (req, res) => {
  if (!checarToken(req, res)) return;
  try {
    const { dpsXml, refId } = req.body || {};
    if (!dpsXml || !refId) return res.status(400).json({ error: 'dpsXml e refId obrigatórios' });
    const { status, body } = await enviarDPS(assinarDPS(dpsXml, refId));
    return res.status(status || 502).json({ refId, ...body });
  } catch (e) {
    console.error('[emitir]', e.message);
    return res.status(502).json({ error: e.message });
  }
});

// POST /emitir-nota  — dados amigáveis da cobrança; monta a DPS a partir do config
// body: { nDPS, vServ, tpAmb?, xDescServ?, tomador:{ cnpj|cpf, xNome, email?, endereco? } }
app.post('/emitir-nota', async (req, res) => {
  if (!checarToken(req, res)) return;
  try {
    const b = req.body || {};
    if (b.nDPS == null || b.vServ == null || !b.tomador) {
      return res.status(400).json({ error: 'nDPS, vServ e tomador são obrigatórios' });
    }
    const { xml, refId } = buildFromConfig(companyCfg, b);
    const { status, body } = await enviarDPS(assinarDPS(xml, refId));
    return res.status(status || 502).json({ refId, ...body });
  } catch (e) {
    console.error('[emitir-nota]', e.message);
    return res.status(502).json({ error: e.message });
  }
});

// erro de parse de JSON não derruba o processo
app.use((err, _req, res, _next) => {
  console.error('[express]', err.message);
  res.status(400).json({ error: 'requisição inválida', detalhe: err.message });
});

// handlers globais: loga mas NÃO encerra o processo
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

app.listen(PORT, '0.0.0.0', () => console.log(`NFS-e Belém signer on :${PORT} -> ${ADN_URL}`));

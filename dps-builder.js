// ============================================================
// Gerador de DPS — NFS-e padrão Nacional v1.01 (RTC IBS/CBS)
// Baseado em DPS_v1.01.xsd + tiposComplexos/tiposSimples v1.01.
// Namespace: http://www.sped.fazenda.gov.br/nfse
// Produz { xml, refId } pronto para assinar no server.js.
// ============================================================
'use strict';

const COD_MUN_BELEM = '1501402'; // IBGE Belém/PA

// escapa texto para XML
const esc = (s) =>
  String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const pad = (s, n) => onlyDigits(s).padStart(n, '0').slice(-n);
const money = (v) => Number(v).toFixed(2); // TSDec15V2: ponto, 2 casas

// monta o Id (chave de 45 chars: DPS + 42 dígitos)
function montarId({ cLocEmi, tpInsc, inscricao, serie, nDPS }) {
  return 'DPS' + pad(cLocEmi, 7) + String(tpInsc) + pad(inscricao, 14) + pad(serie, 5) + pad(nDPS, 15);
}

/**
 * Monta o XML da DPS.
 * @param {object} d dados de entrada (ver README / exemplo abaixo)
 * @returns {{xml:string, refId:string}}
 */
function buildDPS(d) {
  const tpAmb = d.tpAmb || 2;                 // 1=Produção, 2=Homologação
  const cLocEmi = d.cLocEmi || COD_MUN_BELEM; // município emissor
  const dhEmi = d.dhEmi || new Date().toISOString().replace(/\.\d{3}Z$/, '-03:00');
  const serie = d.serie || '1';
  const nDPS = String(d.nDPS);                // sequencial da DPS (controle interno)
  const dCompet = d.dCompet || dhEmi.slice(0, 10); // AAAA-MM-DD

  const p = d.prestador;   // { cnpj, im, opSimpNac, regEspTrib, regApTribSN? }
  const t = d.tomador;     // opcional { cnpj|cpf, xNome, email?, endereco? }
  const s = d.servico;     // { cTribNac, xDescServ, cNBS?, cLocPrestacao? }
  const v = d.valores;     // { vServ, tribISSQN, tpRetISSQN, pAliq?, indTotTrib? }

  const refId = montarId({
    cLocEmi, tpInsc: 1, inscricao: p.cnpj, serie, nDPS,
  });

  // ---------- prestador ----------
  let prest = `<prest>`;
  prest += `<CNPJ>${pad(p.cnpj, 14)}</CNPJ>`;
  if (p.im) prest += `<IM>${esc(p.im)}</IM>`;
  if (p.xNome) prest += `<xNome>${esc(p.xNome)}</xNome>`;
  prest += `<regTrib>`;
  prest += `<opSimpNac>${p.opSimpNac ?? 1}</opSimpNac>`;                 // 1=Não,2=MEI,3=ME/EPP
  if (p.regApTribSN) prest += `<regApTribSN>${p.regApTribSN}</regApTribSN>`;
  prest += `<regEspTrib>${p.regEspTrib ?? 0}</regEspTrib>`;              // 0=Nenhum...
  prest += `</regTrib>`;
  prest += `</prest>`;

  // ---------- tomador (opcional) ----------
  let toma = '';
  if (t) {
    toma += `<toma>`;
    toma += t.cnpj ? `<CNPJ>${pad(t.cnpj, 14)}</CNPJ>` : `<CPF>${pad(t.cpf, 11)}</CPF>`;
    toma += `<xNome>${esc(t.xNome)}</xNome>`;
    if (t.endereco) {
      const e = t.endereco;
      toma += `<end><endNac><cMun>${pad(e.cMun, 7)}</cMun><CEP>${pad(e.cep, 8)}</CEP></endNac>`;
      toma += `<xLgr>${esc(e.logradouro)}</xLgr><nro>${esc(e.numero)}</nro>`;
      if (e.complemento) toma += `<xCpl>${esc(e.complemento)}</xCpl>`;
      toma += `<xBairro>${esc(e.bairro)}</xBairro></end>`;
    }
    if (t.email) toma += `<email>${esc(t.email)}</email>`;
    toma += `</toma>`;
  }

  // ---------- serviço ----------
  let serv = `<serv><locPrest><cLocPrestacao>${pad(s.cLocPrestacao || cLocEmi, 7)}</cLocPrestacao></locPrest>`;
  serv += `<cServ><cTribNac>${esc(s.cTribNac)}</cTribNac>`;              // código de tributação nacional (item LC 116)
  if (s.cTribMun) serv += `<cTribMun>${esc(s.cTribMun)}</cTribMun>`;
  serv += `<xDescServ>${esc(s.xDescServ)}</xDescServ>`;
  if (s.cNBS) serv += `<cNBS>${esc(s.cNBS)}</cNBS>`;
  serv += `</cServ></serv>`;

  // ---------- valores + tributação ----------
  const opSN = p.opSimpNac ?? 1;            // 1=Não optante, 2=MEI, 3=ME/EPP
  const regSN = p.regApTribSN;              // 1=apuração pelo SN
  const convAtivo = d.municipioConvenioAtivo !== false; // Belém = convênio ativo
  const tpRet = v.tpRetISSQN ?? 1;

  let val = `<valores><vServPrest><vServ>${money(v.vServ)}</vServ></vServPrest>`;
  val += `<trib>`;
  val += `<tribMun><tribISSQN>${v.tribISSQN ?? 1}</tribISSQN>`;          // 1=tributável,2=imune,3=exportação,4=não incidência
  val += `<tpRetISSQN>${tpRet}</tpRetISSQN>`;                            // 1=não retido,2=retido tomador,3=retido interm.
  // pAliq: para ME/EPP apurando pelo SN em município de convênio ativo e sem
  // retenção -> PROIBIDO (E0631). Só enviamos quando a regra exige.
  const pAliqProibidoSN = opSN === 3 && regSN === 1 && convAtivo && tpRet === 1;
  if (v.pAliq != null && !pAliqProibidoSN) val += `<pAliq>${Number(v.pAliq).toFixed(2)}</pAliq>`;
  val += `</tribMun>`;
  // totTrib (choice, obrigatório): ME/EPP usa pTotTribSN; indTotTrib é proibido
  // para ME/EPP (E0712) e pTotTribSN é proibido para MEI/Não Optante (E0710/E0713).
  val += `<totTrib>`;
  if (opSN === 3) {
    val += `<pTotTribSN>${Number(v.pTotTribSN ?? 0).toFixed(2)}</pTotTribSN>`;
  } else if (opSN === 2) {                  // MEI
    val += `<indTotTrib>${v.indTotTrib ?? 0}</indTotTrib>`;
  } else {                                  // Não Optante -> valor/percentual aproximado
    val += `<indTotTrib>${v.indTotTrib ?? 0}</indTotTrib>`;
  }
  val += `</totTrib>`;
  val += `</trib></valores>`;

  // ---------- IBSCBS (RTC) — opcional, ativa com d.ibscbs ----------
  let ibscbs = '';
  if (d.ibscbs) {
    const i = d.ibscbs;
    ibscbs += `<IBSCBS>`;
    ibscbs += `<finNFSe>${i.finNFSe ?? 0}</finNFSe>`;
    if (i.indFinal != null) ibscbs += `<indFinal>${i.indFinal}</indFinal>`;
    ibscbs += `<cIndOp>${pad(i.cIndOp, 6)}</cIndOp>`;                    // 6 dígitos
    ibscbs += `<indDest>${i.indDest ?? 0}</indDest>`;
    // TODO: grupo <valores> (TCRTCInfoValoresIBSCBS) — preencher conforme
    // regras de IBS/CBS quando a SEFIN publicar as alíquotas do período de teste.
    ibscbs += (i.valoresXml || '');
    ibscbs += `</IBSCBS>`;
  }

  // ---------- monta infDPS ----------
  let inf = `<infDPS Id="${refId}">`;
  inf += `<tpAmb>${tpAmb}</tpAmb>`;
  inf += `<dhEmi>${dhEmi}</dhEmi>`;
  inf += `<verAplic>${esc(d.verAplic || 'PRORASTRO-1.0')}</verAplic>`;
  inf += `<serie>${esc(serie)}</serie>`;
  inf += `<nDPS>${esc(nDPS)}</nDPS>`;
  inf += `<dCompet>${dCompet}</dCompet>`;
  inf += `<tpEmit>${d.tpEmit || 1}</tpEmit>`;                            // 1=Prestador
  inf += `<cLocEmi>${pad(cLocEmi, 7)}</cLocEmi>`;
  inf += prest + toma + serv + val + ibscbs;
  inf += `</infDPS>`;

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">${inf}</DPS>`;

  return { xml, refId };
}

/**
 * Conveniência: monta a DPS a partir do company.config.json + dados da cobrança.
 * @param {object} cfg  conteúdo de company.config.json
 * @param {object} c    { nDPS, vServ, tomador:{cnpj|cpf,xNome,email?,endereco?}, xDescServ? }
 */
function buildFromConfig(cfg, c) {
  const sp = cfg.servicoPadrao;
  return buildDPS({
    tpAmb: c.tpAmb ?? 2,
    nDPS: c.nDPS,
    serie: cfg.emissao.serie,
    verAplic: cfg.emissao.verAplic,
    tpEmit: cfg.emissao.tpEmit,
    cLocEmi: cfg.emissao.cLocEmi,
    municipioConvenioAtivo: cfg.emissao.municipioConvenioAtivo,
    prestador: cfg.prestador,
    tomador: c.tomador,
    servico: { cTribNac: sp.cTribNac, xDescServ: c.xDescServ || sp.xDescServ, cNBS: sp.cNBS },
    valores: {
      vServ: c.vServ,
      tribISSQN: sp.tribISSQN,
      tpRetISSQN: sp.tpRetISSQN,
      pTotTribSN: sp.pTotTribSN,
    },
  });
}

module.exports = { buildDPS, buildFromConfig, COD_MUN_BELEM };

// ---------------- exemplo rápido (dados reais PRORASTRO) ----------------
if (require.main === module) {
  const cfg = require('./company.config.json');
  const { xml, refId } = buildFromConfig(cfg, {
    nDPS: 1,
    vServ: 99.9,
    tomador: { cpf: '11122233344', xNome: 'Cliente Exemplo', email: 'cliente@ex.com' },
  });
  console.log('refId =', refId, '(len', refId.length, ')');
  console.log(xml);
}

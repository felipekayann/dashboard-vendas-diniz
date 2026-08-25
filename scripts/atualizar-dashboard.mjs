/**
 * Atualiza o dashboard de vendas da rede Óticas Diniz a partir do BI Dataweb.
 *
 * Roda no GitHub Actions (sem interface gráfica). Substitui a automação que
 * antes rodava no PC do usuário via Claude.
 *
 * Variáveis de ambiente obrigatórias:
 *   DW_EMAIL  - e-mail de login no BI Dataweb
 *   DW_SENHA  - senha de login no BI Dataweb
 *
 * O que ele NUNCA altera: o array storeMeta (metas e devoluções são
 * informadas manualmente pelo dono) e a senha "2008" do dashboard.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const TZ = 'America/Sao_Paulo';
const BI_URL = 'https://bi.dataweb.com.br/database/0/dashboard/view?id=Faturometro';
const ARQUIVO = path.resolve('index.html');
const LOJAS = ['Loja 01', 'Loja 02', 'Loja 03', 'Loja 04', 'Loja 05', 'Loja 06', 'Loja 07'];

const log = (...a) => console.log('[dashboard]', ...a);

// ---------------------------------------------------------------- datas ----

/** Retorna {ano, mes, dia, hora, min} no fuso de São Paulo. */
function agoraSP() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  return {
    ano: +p.year, mes: +p.month, dia: +p.day,
    hora: p.hour === '24' ? '00' : p.hour, min: p.minute,
  };
}

const iso = (a, m, d) => `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** Formato que o filtro do BI espera: M/D/AAAA (sem zero à esquerda). */
const formatoBI = (a, m, d) => `${m}/${d}/${a}`;
const ultimoDia = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate();

/** Conta dias do dia 1 até `ate`, excluindo domingos (sábado conta). */
function diasUteis(ano, mes, ate) {
  let n = 0;
  for (let d = 1; d <= ate; d++) {
    if (new Date(Date.UTC(ano, mes - 1, d)).getUTCDay() !== 0) n++;
  }
  return n;
}

// ------------------------------------------------------------ navegação ----

async function login(page) {
  log('abrindo o BI...');
  await page.goto(BI_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  // O BI redireciona para auth.dw.net.br quando não há sessão.
  try {
    await page.waitForSelector('#Input_Email', { timeout: 20_000 });
  } catch {
    log('nenhuma tela de login apareceu — sessão já ativa?');
    return;
  }

  log('preenchendo login...');
  await page.fill('#Input_Email', process.env.DW_EMAIL);
  await page.fill('#Input_Password', process.env.DW_SENHA);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);

  if (await page.locator('#Input_Email').count()) {
    const erro = await page.locator('.validation-summary-errors, .text-danger').first()
      .innerText().catch(() => '');
    throw new Error('Login recusado pelo BI. ' + (erro || 'Confira os secrets DW_EMAIL e DW_SENHA.'));
  }
  log('login OK');

  // O redirecionamento pós-login pode parar na home do portal em vez do
  // dashboard. Voltar explicitamente para a URL do Faturômetro.
  await page.goto(BI_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  log('de volta ao dashboard: ' + page.url());
}

/** Ajusta o filtro de data do dashboard e espera os dados recarregarem. */
async function aplicarFiltro(page, deISO, ateISO) {
  const [a1, m1, d1] = deISO.split('-').map(Number);
  const [a2, m2, d2] = ateISO.split('-').map(Number);
  log(`filtro: ${deISO} até ${ateISO}`);

  try {
    await page.waitForSelector('text=Resumo faturômetro', { timeout: 90_000 });
  } catch (e) {
    const trecho = await page.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => '(sem texto)');
    throw new Error('Dashboard não carregou. URL=' + page.url() + ' | Página mostra: ' + trecho);
  }

  const botao = page.locator(
    '[aria-label="Dashboard Parameters"], [title="Dashboard Parameters"]'
  ).first();
  await botao.click();

  const dialogo = page.locator('.dx-overlay-content, div[role="dialog"]').last();
  await dialogo.waitFor({ timeout: 20_000 });

  const campos = dialogo.locator('input[type="text"]');
  await campos.first().waitFor({ timeout: 20_000 });

  for (const [i, valor] of [formatoBI(a1, m1, d1), formatoBI(a2, m2, d2)].entries()) {
    const campo = campos.nth(i);
    await campo.click();
    await campo.press('Control+a');
    await campo.type(valor, { delay: 30 });
    await campo.press('Tab');
  }

  await dialogo.locator('text=Submit').first().click();
  await page.waitForTimeout(9_000); // DevExpress recarrega os gráficos por XHR
}

/** Lê a tabela "Resumo faturômetro" e devolve {loja: {total, atend}}. */
async function lerResumo(page) {
  const texto = await page.evaluate(() => {
    const alvos = [...document.querySelectorAll('div')].filter(
      e => e.innerText && e.innerText.includes('Resumo faturômetro') && e.innerText.includes('DINIZ')
    );
    if (!alvos.length) return null;
    alvos.sort((a, b) => a.innerText.length - b.innerText.length);
    return alvos[0].innerText;
  });
  if (!texto) throw new Error('Tabela "Resumo faturômetro" não encontrada na página.');

  const lojas = {};
  // Formato do BI: "DINIZ- LOJA 01 4,565.00 4" (número no padrão americano)
  const re = /DINIZ-\s*LOJA\s*(\d{2})\s+([\d.,]+)\s+(\d+)/g;
  let m;
  while ((m = re.exec(texto)) !== null) {
    lojas[`Loja ${m[1]}`] = {
      total: Math.round(parseFloat(m[2].replace(/,/g, '')) * 100) / 100,
      atend: parseInt(m[3], 10),
    };
  }

  const faltando = LOJAS.filter(l => !(l in lojas));
  if (faltando.length) {
    throw new Error(`Lojas ausentes na leitura: ${faltando.join(', ')}. Texto lido:\n${texto.slice(0, 500)}`);
  }

  // Confere com o "Sum =" que o próprio BI exibe, para pegar leitura parcial.
  const somaBI = texto.match(/Sum\s*=\s*([\d.,]+)/);
  if (somaBI) {
    const esperado = parseFloat(somaBI[1].replace(/,/g, ''));
    const calculado = LOJAS.reduce((s, l) => s + lojas[l].total, 0);
    if (Math.abs(esperado - calculado) > 0.5) {
      throw new Error(`Soma não bate: BI diz ${esperado}, somei ${calculado.toFixed(2)}. Leitura parcial.`);
    }
  }
  return lojas;
}

// --------------------------------------------------------------- escrita ---

const brl = n => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = n => n.toFixed(2);

function blocoLojas(dados, indent = '    ') {
  return LOJAS.map(l => `${indent}"${l}": {total: ${num(dados[l].total)}, atend: ${dados[l].atend}},`).join('\n');
}

/** Aplica uma substituição e falha alto se o padrão não existir mais. */
function trocar(html, regex, novo, nome) {
  const achou = html.match(regex);
  if (!achou) throw new Error(`Não encontrei "${nome}" no index.html. A estrutura mudou?`);
  if (achou.length > 1 && regex.flags.includes('g')) {
    throw new Error(`Encontrei "${nome}" ${achou.length} vezes. Arquivo possivelmente duplicado.`);
  }
  return html.replace(regex, () => novo);
}

// ------------------------------------------------------------------ main ---

async function main() {
  if (!process.env.DW_EMAIL || !process.env.DW_SENHA) {
    throw new Error('Secrets DW_EMAIL e/ou DW_SENHA não configurados no repositório.');
  }

  const t = agoraSP();
  const hojeISO = iso(t.ano, t.mes, t.dia);
  const ontem = new Date(Date.UTC(t.ano, t.mes - 1, t.dia - 1));
  const ontemISO = iso(ontem.getUTCFullYear(), ontem.getUTCMonth() + 1, ontem.getUTCDate());
  log(`hoje=${hojeISO} ontem=${ontemISO} ${t.hora}:${t.min}`);

  let html = fs.readFileSync(ARQUIVO, 'utf8');

  // Sanidade antes de mexer: o arquivo não pode estar duplicado.
  for (const [marca, padrao] of [
    ['<!DOCTYPE html>', /<!DOCTYPE html>/g],
    ['id="loginGate"', /id="loginGate"/g],
    ['id="dashboardContent"', /id="dashboardContent"/g],
  ]) {
    const n = (html.match(padrao) || []).length;
    if (n !== 1) throw new Error(`index.html corrompido: ${n} ocorrências de ${marca} (esperado 1).`);
  }

  const baseAtual = html.match(/const MONTH_BASE_DATE = "([^"]*)";/);
  if (!baseAtual) throw new Error('MONTH_BASE_DATE não encontrado no index.html.');
  const precisaRecalcular = baseAtual[1] !== ontemISO;
  log(`MONTH_BASE_DATE atual=${baseAtual[1]} -> recalcular=${precisaRecalcular}`);

  const navegador = await chromium.launch();
  const page = await (await navegador.newContext({
    viewport: { width: 1600, height: 1000 },
    locale: 'pt-BR',
  })).newPage();

  try {
    await login(page);

    // --- Passo 1: vendas de HOJE (toda execução) ---
    await aplicarFiltro(page, hojeISO, hojeISO);
    const hoje = await lerResumo(page);
    const totalHoje = LOJAS.reduce((s, l) => s + hoje[l].total, 0);
    const atendHoje = LOJAS.reduce((s, l) => s + hoje[l].atend, 0);
    log(`hoje: ${brl(totalHoje)} em ${atendHoje} atendimentos`);

    html = trocar(html,
      /const TODAY = \{[\s\S]*?\n\};/,
      `const TODAY = {\n  total: ${num(totalHoje)},\n  atend: ${atendHoje},\n  stores: {\n${blocoLojas(hoje)}\n  },\n};`,
      'const TODAY');

    // --- Passo 2: saldo do mês até ontem (1x por dia) ---
    if (precisaRecalcular) {
      let base;
      if (t.dia === 1) {
        log('dia 1 do mês — zerando MONTH_BASE');
        base = Object.fromEntries(LOJAS.map(l => [l, { total: 0, atend: 0 }]));
      } else {
        await aplicarFiltro(page, iso(t.ano, t.mes, 1), ontemISO);
        base = await lerResumo(page);
      }
      html = trocar(html, /const MONTH_BASE_DATE = "[^"]*";/,
        `const MONTH_BASE_DATE = "${ontemISO}";`, 'MONTH_BASE_DATE');
      html = trocar(html, /const MONTH_BASE = \{[\s\S]*?\n\};/,
        `const MONTH_BASE = {\n${blocoLojas(base, '  ')}\n};`, 'const MONTH_BASE');

      // --- Comparativo: mesmo período do mês anterior ---
      const mesAnt = t.mes === 1 ? 12 : t.mes - 1;
      const anoAnt = t.mes === 1 ? t.ano - 1 : t.ano;
      const diaAnt = Math.min(t.dia, ultimoDia(anoAnt, mesAnt));
      await aplicarFiltro(page, iso(anoAnt, mesAnt, 1), iso(anoAnt, mesAnt, diaAnt));
      const ant = await lerResumo(page);
      const dd = String(diaAnt).padStart(2, '0');
      const mm = String(mesAnt).padStart(2, '0');
      html = trocar(html, /const PREV_PERIOD = \{[\s\S]*?\n\};/,
        `const PREV_PERIOD = {\n  label: "01/${mm} a ${dd}/${mm}",\n` +
        `  total: ${num(LOJAS.reduce((s, l) => s + ant[l].total, 0))},\n` +
        `  atend: ${LOJAS.reduce((s, l) => s + ant[l].atend, 0)},\n  stores: {\n` +
        LOJAS.map(l => `    "${l}": ${num(ant[l].total)},`).join('\n') +
        `\n  },\n};`, 'const PREV_PERIOD');
      log('MONTH_BASE e PREV_PERIOD recalculados');
    }

    // --- Passo 3: dias úteis, timestamp e KPI ---
    const decorridos = diasUteis(t.ano, t.mes, t.dia);
    const totalDU = diasUteis(t.ano, t.mes, ultimoDia(t.ano, t.mes));

    const mb = html.match(/const MONTH_BASE = \{[\s\S]*?\n\};/)[0];
    const acumulado = LOJAS.reduce((s, l) => {
      const m = mb.match(new RegExp(`"${l}":\\s*\\{total:\\s*([\\d.]+)`));
      return s + (m ? parseFloat(m[1]) : 0) + hoje[l].total;
    }, 0);
    const media = acumulado / decorridos;
    log(`acumulado do mês: ${brl(acumulado)} · média/dia útil: ${brl(media)}`);

    const dataFmt = `${String(t.dia).padStart(2, '0')}/${String(t.mes).padStart(2, '0')}/${t.ano}`;
    html = trocar(html, /Atualizado em \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/,
      `Atualizado em ${dataFmt} às ${t.hora}:${t.min}`, 'carimbo de atualização');
    html = trocar(html, /const DIAS_UTEIS_DECORRIDOS = \d+;/,
      `const DIAS_UTEIS_DECORRIDOS = ${decorridos};`, 'DIAS_UTEIS_DECORRIDOS');
    html = trocar(html, /const DIAS_UTEIS_TOTAL = \d+;/,
      `const DIAS_UTEIS_TOTAL = ${totalDU};`, 'DIAS_UTEIS_TOTAL');
    html = trocar(html,
      /<div class="label">Média por dia útil \(\d+\/\d+\)<\/div>\s*<div class="value gold">[^<]*<\/div>/,
      `<div class="label">Média por dia útil (${decorridos}/${totalDU})</div>\n        ` +
      `<div class="value gold">${brl(media)}</div>`, 'KPI Média por dia útil');

    // --- Passo 4: validação antes de gravar ---
    for (const [marca, padrao] of [
      ['<!DOCTYPE html>', /<!DOCTYPE html>/g],
      ['id="loginGate"', /id="loginGate"/g],
      ['id="pwBtn"', /id="pwBtn"/g],
      ['</html>', /<\/html>/g],
    ]) {
      const n = (html.match(padrao) || []).length;
      if (n !== 1) throw new Error(`Resultado inválido: ${n} ocorrências de ${marca}.`);
    }
    for (const bloco of html.match(/<script[^>]*>[\s\S]*?<\/script>/g) || []) {
      const js = bloco.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
      new Function(js); // lança se houver erro de sintaxe
    }

    fs.writeFileSync(ARQUIVO, html, 'utf8');
    fs.writeFileSync('resumo.txt',
      `Hoje: ${brl(totalHoje)} (${atendHoje} atendimentos)\n` +
      `Mês: ${brl(acumulado)} · dia útil ${decorridos}/${totalDU}\n` +
      `Zeradas hoje: ${LOJAS.filter(l => hoje[l].atend === 0).join(', ') || 'nenhuma'}\n`);
    log('index.html atualizado com sucesso');
  } catch (e) {
    await page.screenshot({ path: 'erro.png', fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await navegador.close();
  }
}

main().catch(e => { console.error('[dashboard] FALHOU:', e.message); process.exit(1); });

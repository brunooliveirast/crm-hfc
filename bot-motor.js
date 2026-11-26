/* Motor do bot de pré-atendimento do CRM.
   O MESMO arquivo roda no navegador (simulador do editor) e no conector da VPS (conversa de verdade).
   Fluxo = { nos: { <id>: { tipo, x, y, ...config } }, ligacoes: [ { de, saida, para } ] }
   Tipos: inicio · mensagem · midia · menu · pergunta · horario · acao · humano · fim
   Mensagem de mídia sai como objeto { tipo: 'imagem'|'video', midia: url (+ '#gif' = toca como GIF), texto } */
(function (g) {
  'use strict';
  const MAX_PASSOS = 30;
  const TZ = 'America/Sao_Paulo';

  const TIPOS = {
    inicio:   { nome: 'Início',              saidas: ['saida'] },
    mensagem: { nome: 'Mensagem',            saidas: ['saida'] },
    midia:    { nome: 'Imagem ou GIF',       saidas: ['saida'] },
    menu:     { nome: 'Menu de opções',      saidas: null },           // op0..opN + invalido
    pergunta: { nome: 'Pergunta',            saidas: ['saida'] },
    horario:  { nome: 'Horário de atendimento', saidas: ['dentro', 'fora'] },
    acao:     { nome: 'Ação no card',        saidas: ['saida'] },
    humano:   { nome: 'Passar pro atendente', saidas: [] },
    fim:      { nome: 'Encerrar',            saidas: [] },
  };
  const CAMPOS = { nome: 'Nome', email: 'E-mail', data_visita: 'Data da visita', adultos: 'Adultos', criancas: 'Crianças', obs: 'Observação' };

  function saidasDe(no) {
    if (!no) return [];
    if (no.tipo === 'menu') return (no.opcoes || []).map((_, i) => 'op' + i).concat(['invalido']);
    return (TIPOS[no.tipo] || {}).saidas || [];
  }

  const sem = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

  function agoraSP(agora) {
    const d = agora ? new Date(agora) : new Date();
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', hour12: false })
      .formatToParts(d).forEach(x => { p[x.type] = x.value; });
    const dia = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
    const h = Number(p.hour) % 24, m = Number(p.minute);
    return { dia, min: h * 60 + m, hora: h, ano: Number(p.year), mes: Number(p.month), d: Number(p.day) };
  }

  function saudacao(agora) { const h = agoraSP(agora).hora; return h < 12 ? 'bom dia' : h < 18 ? 'boa tarde' : 'boa noite'; }

  function primeiroNome(nome) {
    const n = String(nome || '').trim();
    if (!n || /\d{4,}/.test(n) || /^contato do whatsapp$/i.test(n)) return '';
    return n.split(/\s+/)[0];
  }

  function texto(t, s, agora) {
    const nome = primeiroNome((s.vars && s.vars.nome) || (s.lead && s.lead.nome));
    return String(t || '')
      .replace(/\{saudacao\}/gi, saudacao(agora))
      .replace(/\{nome\}/gi, nome)
      .replace(/ ,/g, ',').replace(/\s+([!?.,])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
  }

  const minutos = hhmm => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

  function dentroDoHorario(no, agora) {
    const a = agoraSP(agora), dias = Array.isArray(no.dias) && no.dias.length ? no.dias.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    const ini = minutos(no.ini) ?? 0, fim = minutos(no.fim) ?? 24 * 60;
    return dias.includes(a.dia) && a.min >= ini && a.min < fim;
  }

  // ---------- leitura das respostas ----------
  function lerCampo(campo, txt, agora) {
    const t = String(txt || '').trim();
    if (!t) return null;
    if (campo === 'nome') { const n = t.replace(/^(meu nome (e|é)|sou o|sou a|me chamo)\s+/i, '').trim(); return n.length >= 2 && n.length <= 80 && !/\d{3,}/.test(n) ? n : null; }
    if (campo === 'email') { const m = /[^@\s]+@[^@\s]+\.[^@\s]+/.exec(t); return m ? m[0].toLowerCase() : null; }
    if (campo === 'adultos' || campo === 'criancas') {
      const m = /\d+/.exec(t); if (m) return Math.min(Number(m[0]), 500);
      const ext = { nenhum: 0, nenhuma: 0, zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10 };
      const w = sem(t).split(/\s+/).find(x => x in ext); return w != null ? ext[w] : null;
    }
    if (campo === 'data_visita') {
      const a = agoraSP(agora), s = sem(t);
      const iso = (y, m, d) => { const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCMonth() === m - 1 ? dt.toISOString().slice(0, 10) : null; };
      const soma = n => { const dt = new Date(Date.UTC(a.ano, a.mes - 1, a.d + n)); return dt.toISOString().slice(0, 10); };
      if (/\bhoje\b/.test(s)) return soma(0);
      if (/depois de amanha/.test(s)) return soma(2);
      if (/\bamanha\b/.test(s)) return soma(1);
      const m = /(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?:\s*[\/\-.]\s*(\d{2,4}))?/.exec(t);
      if (m) {
        const d = Number(m[1]), mes = Number(m[2]);
        let y = m[3] ? Number(m[3]) : a.ano; if (y < 100) y += 2000;
        if (!m[3] && (mes < a.mes || (mes === a.mes && d < a.d))) y += 1;   // "15/01" em dezembro = ano que vem
        return iso(y, mes, d);
      }
      return null;
    }
    return t.slice(0, 500);   // obs
  }

  function escolherOpcao(no, txt) {
    const ops = no.opcoes || [], t = sem(txt);
    if (!t) return -1;
    const n = /^\D*(\d{1,2})\b/.exec(t);
    if (n && Number(n[1]) >= 1 && Number(n[1]) <= ops.length && t.replace(/\D/g, '').length <= 2) return Number(n[1]) - 1;
    let i = ops.findIndex(o => sem(o) === t); if (i >= 0) return i;
    i = ops.findIndex(o => sem(o).length >= 3 && (t.includes(sem(o)) || sem(o).includes(t) && t.length >= 4)); return i;
  }

  function textoMenu(no, s, agora) {
    const ops = (no.opcoes || []).map((o, i) => (i + 1) + ' - ' + o).join('\n');
    return [texto(no.texto, s, agora), ops].filter(Boolean).join('\n\n');
  }

  // ---------- começar ou não ----------
  function inicioDe(fluxo) {
    const nos = (fluxo && fluxo.nos) || {};
    const id = Object.keys(nos).find(k => nos[k].tipo === 'inicio');
    return id ? { id, no: nos[id] } : null;
  }

  /* ctx = { sessao, humana_recente, total, anterior_em, lead }  (vem do bot_conector_contexto)
     devolve 'continuar' | 'comecar' | null */
  function decidir(fluxoReg, ctx, txt, agora) {
    if (!fluxoReg || !fluxoReg.dados) return null;
    if (ctx.humana_recente) return null;
    const s = ctx.sessao;
    if (s && !s.fim && s.esperando && String(s.fluxo_id) === String(fluxoReg.id)) return 'continuar';
    if (ctx.lead && ['ganho', 'perdido'].includes(ctx.lead.etapa)) return null;
    const ini = inicioDe(fluxoReg.dados); if (!ini) return null;
    const c = ini.no, t = sem(txt);
    const palavras = String(c.palavras || '').split(',').map(sem).filter(Boolean);
    if (palavras.length && palavras.some(p => t.includes(p))) return 'comecar';
    if (s && !s.fim) return null;   // já tem conversa do bot aberta (sem esperar resposta)
    // acabou de passar pro atendente e ninguém respondeu ainda: o bot não recomeça por cima
    const ag0 = agora ? new Date(agora).getTime() : Date.now();
    if (s && s.fim && /atendente|opção/.test(s.motivo || '') && s.atualizado_em && ag0 - new Date(s.atualizado_em).getTime() < 12 * 3600000) return null;
    const gat = c.gatilho || 'novo';
    if (gat === 'novo') return Number(ctx.total || 0) <= 1 ? 'comecar' : null;
    if (gat === 'sem_conversa') {
      const dias = Math.max(1, Number(c.dias || 1));
      if (Number(ctx.total || 0) <= 1 || !ctx.anterior_em) return 'comecar';
      const ag = agora ? new Date(agora).getTime() : Date.now();
      return ag - new Date(ctx.anterior_em).getTime() >= dias * 86400000 ? 'comecar' : null;
    }
    return null;   // 'palavra' = só por palavra-chave
  }

  // ---------- andar no fluxo ----------
  /* fluxoReg = { id, dados }  sessao = linha de bot_sessoes (ou null)  lead = { nome, ... }
     devolve { msgs: [texto...], set: {campo: valor}, sessao: {...} } */
  function passo(fluxoReg, sessao, lead, txt, agora, comecar) {
    const f = fluxoReg.dados || {}, nos = f.nos || {}, lig = f.ligacoes || [];
    const prox = (de, saida) => { const l = lig.find(x => x.de === de && x.saida === saida); return l && nos[l.para] ? l.para : null; };
    const s = comecar || !sessao
      ? { fluxo_id: fluxoReg.id, no: null, esperando: false, tentativas: 0, vars: {}, fim: false, motivo: null }
      : { fluxo_id: sessao.fluxo_id, no: sessao.no, esperando: !!sessao.esperando, tentativas: sessao.tentativas || 0, vars: Object.assign({}, sessao.vars || {}), fim: false, motivo: null };
    const ctxTxt = { vars: s.vars, lead: lead || {} };
    const out = { msgs: [], set: {}, sessao: s };
    const notas = [];
    let atual = null;

    if (comecar || !sessao) {
      const ini = inicioDe(f); if (!ini) { s.fim = true; s.motivo = 'fluxo sem início'; return out; }
      atual = prox(ini.id, 'saida');
    } else if (s.esperando && nos[s.no]) {
      const no = nos[s.no];
      if (no.tipo === 'menu') {
        const i = escolherOpcao(no, txt);
        if (i >= 0) {
          s.tentativas = 0; s.esperando = false;
          (s.vars.respostas = s.vars.respostas || []).push((no.titulo || 'Menu') + ': ' + no.opcoes[i]);
          atual = prox(s.no, 'op' + i);
        } else {
          s.tentativas += 1;
          const inv = prox(s.no, 'invalido');
          if (s.tentativas >= 2) { s.esperando = false; s.tentativas = 0; atual = inv || '__humano'; }
          else { out.msgs.push(texto(no.invalido || 'Não entendi 😅 Responda só com o número da opção:', ctxTxt, agora) + '\n\n' + (no.opcoes || []).map((o, k) => (k + 1) + ' - ' + o).join('\n')); return fechar(); }
        }
      } else if (no.tipo === 'pergunta') {
        const v = lerCampo(no.campo || 'obs', txt, agora);
        if (v == null && s.tentativas < 1 && no.campo !== 'obs') {
          s.tentativas += 1;
          out.msgs.push(texto(no.invalido || 'Não consegui entender. Pode escrever de novo?', ctxTxt, agora) + (no.campo === 'data_visita' ? ' (ex.: 14/12)' : ''));
          return fechar();
        }
        s.tentativas = 0; s.esperando = false;
        const campo = no.campo || 'obs';
        if (v != null) {
          if (campo === 'obs') out.set.obs = (no.titulo || 'Bot') + ': ' + v; else out.set[campo] = v;
          s.vars[campo] = v;
          (s.vars.respostas = s.vars.respostas || []).push((CAMPOS[campo] || campo) + ': ' + (campo === 'data_visita' ? String(v).split('-').reverse().join('/') : v));
        } else (s.vars.respostas = s.vars.respostas || []).push((CAMPOS[campo] || campo) + ': "' + String(txt || '').slice(0, 80) + '"');
        atual = prox(s.no, 'saida');
      } else atual = null;
    } else {
      s.fim = true; s.motivo = 'sessão sem pergunta aberta'; return out;
    }

    let n = 0;
    while (atual && n++ < MAX_PASSOS) {
      if (atual === '__humano') { paraHumano({ texto: 'Vou te passar pra um atendente, tá? Já já alguém te responde. 🙂' }, 'cliente não escolheu opção válida'); break; }
      const no = nos[atual]; if (!no) break;
      s.no = atual;
      if (no.tipo === 'midia') {
        if (no.url) out.msgs.push({ tipo: no.formato === 'imagem' ? 'imagem' : 'video', midia: String(no.url).trim() + (no.formato === 'imagem' || no.formato === 'video' ? '' : '#gif'), texto: texto(no.legenda || '', ctxTxt, agora) });
        atual = prox(atual, 'saida'); continue;
      }
      if (no.tipo === 'mensagem') { const t = texto(no.texto, ctxTxt, agora); if (t) out.msgs.push(t); atual = prox(atual, 'saida'); continue; }
      if (no.tipo === 'menu') { out.msgs.push(textoMenu(no, ctxTxt, agora)); s.esperando = true; s.tentativas = 0; return fechar(); }
      if (no.tipo === 'pergunta') { out.msgs.push(texto(no.texto, ctxTxt, agora)); s.esperando = true; s.tentativas = 0; return fechar(); }
      if (no.tipo === 'horario') { atual = prox(atual, dentroDoHorario(no, agora) ? 'dentro' : 'fora'); continue; }
      if (no.tipo === 'acao') {
        ['etapa', 'setor', 'etiqueta'].forEach(k => { if (no[k]) out.set[k] = no[k]; });
        if (no.tipoLead) out.set.tipo = no.tipoLead;
        atual = prox(atual, 'saida'); continue;
      }
      if (no.tipo === 'humano') { paraHumano(no, 'passou pro atendente'); return fechar(); }
      if (no.tipo === 'fim') { const t = texto(no.texto, ctxTxt, agora); if (t) out.msgs.push(t); s.fim = true; s.motivo = 'fluxo encerrado'; s.esperando = false; return fechar(); }
      atual = prox(atual, 'saida');
    }
    if (!s.esperando && !s.fim) { s.fim = true; s.motivo = n >= MAX_PASSOS ? 'fluxo em círculo' : 'fluxo terminou'; }
    return fechar();

    function paraHumano(no, motivo) {
      const t = texto(no.texto || '', ctxTxt, agora); if (t) out.msgs.push(t);
      out.set.etiqueta = 'aguardando atendente';
      if (no.setor) out.set.setor = no.setor;
      // entrega pra uma atendente que está online (o banco escolhe e troca {atendente} pelo nome dela)
      if (no.distribuir !== false) out.set.distribuir = true;
      s.fim = true; s.esperando = false; s.motivo = motivo;
      const r = (s.vars.respostas || []);
      notas.push('🤖 Bot passou pro atendente.' + (r.length ? '\n' + r.join('\n') : ''));
    }
    function fechar() {
      if (notas.length) out.set.nota = notas.join('\n');
      return out;
    }
  }

  // ---------- conferência antes de ativar ----------
  function conferir(fluxo) {
    const nos = (fluxo && fluxo.nos) || {}, lig = (fluxo && fluxo.ligacoes) || [], erros = [];
    const ids = Object.keys(nos);
    const inis = ids.filter(k => nos[k].tipo === 'inicio');
    if (inis.length !== 1) erros.push('O fluxo precisa de exatamente 1 bloco Início.');
    if (inis.length === 1 && !lig.some(l => l.de === inis[0])) erros.push('Ligue o Início no primeiro bloco.');
    ids.forEach(k => {
      const no = nos[k], nome = (TIPOS[no.tipo] || {}).nome || no.tipo;
      if (['mensagem', 'menu', 'pergunta'].includes(no.tipo) && !String(no.texto || '').trim()) erros.push(nome + ' sem texto.');
      if (no.tipo === 'menu' && !(no.opcoes || []).filter(o => String(o).trim()).length) erros.push('Menu sem opções.');
      if (no.tipo === 'menu') (no.opcoes || []).forEach((o, i) => { if (!lig.some(l => l.de === k && l.saida === 'op' + i)) erros.push('Opção "' + o + '" do menu não está ligada a nada.'); });
      if (no.tipo !== 'inicio' && !lig.some(l => l.para === k)) erros.push(nome + (no.titulo ? ' "' + no.titulo + '"' : '') + ' está solto (nada chega nele).');
    });
    return erros;
  }

  // ---------- modelo inicial: a "Ju" (textos tirados do site do hotel, sem preço) ----------
  function modelo() {
    return {
      nos: {
        n13: { tipo: 'midia', x: 300, y: 40, titulo: 'Ju dando tchau', formato: 'gif', url: 'https://brunooliveirast.com.br/coninho/ju-tchau.mp4', legenda: '' },
        n1: { tipo: 'inicio', x: 40, y: 220, gatilho: 'sem_conversa', dias: 30, palavras: 'menu, ju' },
        n2: { tipo: 'mensagem', x: 300, y: 220, texto: 'Olá, {saudacao}! 😊 Eu sou a *Ju*, do *Hotel Fazenda Coninho*.\n\nVou fazer o seu atendimento inicial e já te passo para uma das nossas atendentes.' },
        n3: { tipo: 'menu', x: 560, y: 200, titulo: 'Assunto', texto: 'Hoje você busca atendimento para:', opcoes: ['Day Use', 'Hospedagem', 'Outro assunto'], invalido: 'Não entendi 😅 Me responde só com o número da opção:' },
        n4: { tipo: 'acao', x: 860, y: 20, etapa: 'atendimento', tipoLead: 'dayuse' },
        n5: { tipo: 'mensagem', x: 1120, y: 20, titulo: 'Sobre o Day Use', texto: 'Que bom! ☀️ O nosso *Day Use* é um dia inteiro na fazenda, aos fins de semana e feriados.\n\nEstão incluídos as piscinas semiaquecidas, a sauna, os passeios a cavalo e de charrete, a recreação infantil com monitoras e a comida mineira feita no fogão a lenha: tira-gosto, almoço à vontade e mesa de doces.' },
        n6: { tipo: 'mensagem', x: 1380, y: 20, titulo: 'Transferindo (Day Use)', texto: 'Estou te transferindo para {atendente}, nossa especialista em Day Use. 😊\n\nEnquanto você aguarda, deixa eu te contar um pouquinho sobre o Coninho:' },
        n7: { tipo: 'acao', x: 860, y: 260, etapa: 'atendimento', tipoLead: 'hospedagem' },
        n8: { tipo: 'mensagem', x: 1120, y: 260, titulo: 'Sobre a hospedagem', texto: 'Que bom! 🏡 A nossa *hospedagem* é de fim de semana e feriado, com *pensão completa*: café da manhã, tira-gosto, almoço, sobremesa e jantar.\n\nSão chalés para 2 a 8 pessoas, todos com ar-condicionado, frigobar, TV, wi-fi e varanda. Todo o lazer da fazenda está incluído, e cães de pequeno porte são bem-vindos em alguns chalés. 🐾' },
        n9: { tipo: 'mensagem', x: 1380, y: 260, titulo: 'Transferindo (hospedagem)', texto: 'Estou te transferindo para {atendente}, nossa especialista em hospedagem. 😊\n\nEnquanto você aguarda, deixa eu te contar um pouquinho sobre o Coninho:' },
        n10: { tipo: 'mensagem', x: 1640, y: 140, titulo: 'Sobre o Coninho', texto: '🌳 O *Hotel Fazenda Coninho* fica em Inhaúma (MG), a 20 km de Sete Lagoas e 80 km de BH: pertinho, mas longe da correria.\n\n🍲 Comida mineira feita no fogão a lenha\n🏊 Piscinas semiaquecidas e sauna\n🐴 Passeio a cavalo e de charrete\n🧒 Recreação infantil com monitoras\n\nQuem vem, volta! 💚' },
        n11: { tipo: 'humano', x: 1900, y: 140, texto: 'Em instantes a gente continua por aqui. 🙂', distribuir: true },
        n12: { tipo: 'humano', x: 860, y: 480, texto: 'Certo! Estou te transferindo para {atendente}, que vai te ajudar com isso. 😊', distribuir: true },
      },
      ligacoes: [
        { de: 'n1', saida: 'saida', para: 'n13' }, { de: 'n13', saida: 'saida', para: 'n2' }, { de: 'n2', saida: 'saida', para: 'n3' },
        { de: 'n3', saida: 'op0', para: 'n4' }, { de: 'n3', saida: 'op1', para: 'n7' }, { de: 'n3', saida: 'op2', para: 'n12' }, { de: 'n3', saida: 'invalido', para: 'n12' },
        { de: 'n4', saida: 'saida', para: 'n5' }, { de: 'n5', saida: 'saida', para: 'n6' }, { de: 'n6', saida: 'saida', para: 'n10' },
        { de: 'n7', saida: 'saida', para: 'n8' }, { de: 'n8', saida: 'saida', para: 'n9' }, { de: 'n9', saida: 'saida', para: 'n10' },
        { de: 'n10', saida: 'saida', para: 'n11' },
      ],
    };
  }

  const api = { TIPOS, CAMPOS, saidasDe, decidir, passo, conferir, modelo, dentroDoHorario, lerCampo, escolherOpcao, saudacao, agoraSP };
  g.BotMotor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

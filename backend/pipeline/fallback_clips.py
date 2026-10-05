"""Deterministic clip generation used when AI analysis is unavailable.

Builds cuts that:
- start and end on full sentences (cues are merged into sentences by punctuation/pauses);
- are chosen by how well each stretch matches the selected video category
  (keyword lexicon + speech signals), not by evenly splitting the timeline;
- get an individual score computed from that clip's own content.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Dict, List, Optional, Sequence

from .quality import DurationProfile, profile_from_srt, to_seconds

_END_PUNCT = re.compile(r"[.!?…。！？]['\")\]]*\s*$")
_PAUSE_SEC = 0.8

# Léxico por categoria (sem acento, minúsculo). Vale para pt-BR e um pouco de inglês.
_LEXICON: Dict[str, List[str]] = {
    "entertainment": ["kkk", "haha", "rs", "risada", "engracad", "piada", "zoeira", "brincadeira", "caramba",
                      "nossa", "meu deus", "mano", "cara", "doido", "loucura", "incrivel", "surreal", "chocad",
                      "gente", "olha isso", "socorro", "vergonha", "trollei", "desafio", "funny", "lol", "wow"],
    "knowledge": ["porque", "significa", "conceito", "explica", "exemplo", "estudo", "pesquisa", "ciencia",
                  "dados", "funciona", "processo", "definicao", "teoria", "historia", "descobr", "entender",
                  "aprender", "na verdade", "ou seja", "por isso"],
    "business": ["dinheiro", "venda", "cliente", "empresa", "negocio", "lucro", "faturamento", "mercado",
                 "investimento", "investir", "estrategia", "marketing", "produto", "empreend", "reais", "milh",
                 "crescimento", "receita", "custo", "preco"],
    "experience": ["dica", "passo", "primeiro", "segundo", "depois", "como fazer", "eu fiz", "aprendi",
                   "minha experiencia", "funcionou", "erro", "cuidado", "recomendo", "truque", "metodo",
                   "resultado", "tenta", "faca"],
    "opinion": ["eu acho", "na minha opiniao", "discordo", "concordo", "absurdo", "verdade", "polemic",
                "critica", "deveria", "problema", "ninguem", "todo mundo", "sinceramente", "eu penso",
                "errado", "certo", "defendo"],
    "speech": ["voces", "nunca desista", "sonho", "objetivo", "vida", "futuro", "acredite", "forca",
               "coragem", "lembre", "importante", "mudar", "sucesso", "proposito", "gratidao", "juntos"],
    "content_review": ["filme", "serie", "episodio", "personagem", "cena", "final", "roteiro", "nota",
                       "vale a pena", "assisti", "livro", "jogo", "analise", "review", "spoiler", "melhor",
                       "pior", "recomendo"],
}

_REASON = {
    "entertainment": "Trecho com mais reações e momentos divertidos",
    "knowledge": "Trecho com explicações e conteúdo informativo",
    "business": "Trecho focado em negócios, dinheiro e estratégia",
    "experience": "Trecho com dicas e experiência prática",
    "opinion": "Trecho com opiniões e posicionamentos fortes",
    "speech": "Trecho com mensagem marcante e inspiradora",
    "content_review": "Trecho com análise e comentários sobre a obra",
    "default": "Trecho com fala contínua e bem desenvolvida",
}


def _norm(text: str) -> str:
    t = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in t if not unicodedata.combining(c))


def _sentences(entries: Sequence[Dict[str, Any]], max_sentence: float = 25.0) -> List[Dict[str, Any]]:
    """Merge subtitle cues into complete sentences."""
    out: List[Dict[str, Any]] = []
    cur: Optional[Dict[str, Any]] = None
    for i, e in enumerate(entries):
        s, en = to_seconds(e["start_time"]), to_seconds(e["end_time"])
        text = str(e.get("text") or "").strip()
        if cur is None:
            cur = {"start": s, "end": en, "start_time": e["start_time"], "end_time": e["end_time"], "text": text}
        else:
            cur["end"], cur["end_time"] = en, e["end_time"]
            cur["text"] = (cur["text"] + " " + text).strip()
        nxt = entries[i + 1] if i + 1 < len(entries) else None
        gap = (to_seconds(nxt["start_time"]) - en) if nxt else 99
        if _END_PUNCT.search(text) or gap >= _PAUSE_SEC or (cur["end"] - cur["start"]) > max_sentence:
            out.append(cur)
            cur = None
    if cur:
        out.append(cur)
    return out


def _signal(text: str, category: str) -> float:
    n = _norm(text)
    words = max(1, len(n.split()))
    lex = _LEXICON.get(category, [])
    hits = sum(n.count(k) for k in lex)
    excl = text.count("!") + text.count("?")
    laugh = len(re.findall(r"\b(k{3,}|(ha){2,}|rs+)\b", n)) + n.count("[risos]") + n.count("(risos)")
    score = hits * 1.0 + excl * 0.4
    if category == "entertainment":
        score += laugh * 1.5 + excl * 0.4
    elif category in ("opinion", "speech"):
        score += excl * 0.3
    return score / words * 10  # densidade por ~10 palavras


def build_fallback_clips(
    srt_entries: Sequence[Dict[str, Any]],
    profile: DurationProfile | None = None,
    category: str | None = None,
) -> List[Dict[str, Any]]:
    valid: List[Dict[str, Any]] = []
    for entry in srt_entries:
        try:
            if to_seconds(entry["end_time"]) > to_seconds(entry["start_time"]):
                valid.append(dict(entry))
        except (KeyError, TypeError, ValueError):
            continue
    if not valid:
        return []

    category = (category or "default").strip() or "default"
    profile = profile or profile_from_srt(valid)
    tmin, tmax = profile.target_clip_sec
    target = profile.user_target_sec or (tmin + tmax) / 2
    max_len = max(profile.max_clip_sec, target)
    # frases muito longas (transcrição sem pontuação) estouram a duração escolhida
    sents = _sentences(valid, max_sentence=max(6.0, min(25.0, target * 0.35)))
    total = sents[-1]["end"] - sents[0]["start"]
    min_len = min(profile.min_clip_sec, target)
    desired = max(profile.topics_hint[0], round(total / max(target * 1.6, 1)))
    count = max(1, min(profile.max_clips, profile.topics_hint[1], desired))

    sig = [_signal(s["text"], category) for s in sents]

    # Candidatos: janelas de frases completas, começando em cada frase.
    cands = []
    for i in range(len(sents)):
        j = i
        while j < len(sents):
            dur = sents[j]["end"] - sents[i]["start"]
            if dur >= target or dur >= max_len or j == len(sents) - 1:
                break
            if sents[j + 1]["end"] - sents[i]["start"] > max_len:
                break
            j += 1
        dur = sents[j]["end"] - sents[i]["start"]
        if dur < min_len and total >= min_len:
            continue
        span = sig[i:j + 1]
        words = sum(len(s["text"].split()) for s in sents[i:j + 1])
        density = words / max(dur, 1)  # fala contínua
        raw = sum(span) / len(span) + 0.25 * max(span) + 0.05 * min(density, 4)
        # começo/fim limpos valem um pouco mais
        if _END_PUNCT.search(sents[j]["text"]):
            raw += 0.1
        cands.append((raw, i, j))

    if not cands:
        cands = [(0.0, 0, len(sents) - 1)]

    cands.sort(key=lambda c: c[0], reverse=True)
    chosen: List[tuple] = []
    for c in cands:
        _, i, j = c
        if any(not (j < a or i > b) for _, a, b in chosen):
            continue
        chosen.append(c)
        if len(chosen) >= count:
            break

    raws = [c[0] for c in chosen]
    lo, hi = min(raws), max(raws)
    clips: List[Dict[str, Any]] = []
    for idx, (raw, i, j) in enumerate(sorted(chosen, key=lambda c: c[1]), 1):
        seg = sents[i:j + 1]
        text = " ".join(s["text"] for s in seg).strip()
        title = re.sub(r"\s+", " ", seg[0]["text"]).strip() or f"Trecho {idx}"
        if len(title) > 72:
            title = title[:69].rstrip() + "..."
        rel = (raw - lo) / (hi - lo) if hi > lo else 0.5
        absolute = min(1.0, raw / 3.0)
        score = round(max(0.35, min(0.97, 0.4 + 0.35 * rel + 0.22 * absolute)), 2)
        clips.append({
            "id": str(idx),
            "outline": title,
            "content": text,
            "start_time": seg[0]["start_time"],
            "end_time": seg[-1]["end_time"],
            "generated_title": title,
            "final_score": score,
            "recommend_reason": _REASON.get(category, _REASON["default"]),
            "chunk_index": 0,
            "fallback_generated": True,
            "video_category": category,
        })
    return clips

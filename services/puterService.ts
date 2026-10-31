import { AppMode, ChartConfig, GroundingSource, Message } from '../types';
import { SYSTEM_INSTRUCTION } from '../constants';

interface GenerateParams {
  prompt: string;
  history?: Message[];
  imageBase64?: string;
  mode: AppMode;
  country?: string;
  currency?: string;
}

interface ServiceResponse {
  text: string;
  chartConfig?: ChartConfig;
  groundingSources?: GroundingSource[];
}

function buildPuterOptions(params: GenerateParams) {
  const { mode, country, currency } = params;
  let modeInstruction = '';

  if (mode === AppMode.DATA_ANALYSIS) {
    modeInstruction = `
You are in DATA ANALYSIS mode. Return ONLY one valid JSON object matching this schema:
{"visualize":true,"chartType":"line|bar|area|pie|radar","title":"string","xAxisKey":"label","dataKey":"value","color":"#06b6d4","data":[{"label":"string","value":0}]}
Do not include Markdown, explanations, headings, or code fences. Every data item must contain a string label and numeric value.
`;
  } else if (mode === AppMode.MARKET_VALUATION) {
    modeInstruction = `
You are in MARKET VALUATION mode for ${country || 'United States'} using ${currency || 'USD'}.
Always answer using this exact Markdown structure:
## Valuation Summary
- Asset:
- Location:
- Currency:

## Estimated Values
| Measure | Value |
|---|---:|
| Fair Market Value | |
| Liquidation Value | |
| Scrap Value | |

## Assumptions
- [state assumptions here]

## Recommendation

If essential specifications are missing, keep the same headings and put "Insufficient information" in the affected sections, followed by a numbered list of the exact details required. Never invent precise prices or use another currency.
`;
  } else {
    modeInstruction = `
Use structured Markdown for every response: a short ## Summary, then relevant ## Findings, ## Evidence or ## Assumptions, and ## Recommendation sections. Use bullets or tables instead of long unbroken prose.
`;
  }

  const options: any = {
    model: 'gemini-3-flash-preview',
    temperature: 0.2,
    system: `${SYSTEM_INSTRUCTION}\n\n${modeInstruction}`
  };
  options.system += `\nMODE:${AppMode[mode] || 'STANDARD'}; Country:${country || 'United States'}; Currency:${currency || 'USD'}`;
  return options;
}

export const generateResponse = async ({ prompt, history, imageBase64, mode, country, currency }: GenerateParams): Promise<ServiceResponse> => {
  if (!(window as any).puter || !(window as any).puter.ai) {
    throw new Error('Puter not loaded');
  }

  let fullPrompt = prompt;
  if (history && history.length) {
    const hist = history.slice(-10).map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n');
    fullPrompt = `${hist}\n\nUser: ${prompt}`;
  }

  const options = buildPuterOptions({ prompt, history, imageBase64, mode, country, currency });

  let response: any;
  if (imageBase64) {
    response = await (window as any).puter.ai.chat(fullPrompt, imageBase64, options);
  } else {
    response = await (window as any).puter.ai.chat(fullPrompt, options);
  }

  const text = extractResponseText(response);
  const parsed = extractChartConfig(text);

  return {
    text: parsed.text,
    chartConfig: parsed.chartConfig,
    groundingSources: response?.groundingSources
  };
};

function extractResponseText(response: any): string {
  let current = response;

  // Puter may return the provider envelope either as an object or as a
  // JSON-encoded string. Unwrap those layers before rendering assistant text.
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current === 'string') {
      try {
        const parsed = JSON.parse(current);
        if (parsed && typeof parsed === 'object') {
          current = parsed;
          continue;
        }
      } catch {
        return current;
      }
      return current;
    }

    if (Array.isArray(current)) {
      current = current[0];
      continue;
    }

    if (typeof current?.message?.content === 'string') {
      return current.message.content;
    }

    if (Array.isArray(current?.message?.content)) {
      return current.message.content
        .map((part: any) => typeof part === 'string' ? part : part?.text || '')
        .join('');
    }

    if (typeof current?.text === 'string') {
      return current.text;
    }

    if (current?.message) {
      current = current.message;
      continue;
    }

    break;
  }

  return typeof current === 'string' ? current : JSON.stringify(current);
}

function extractChartConfig(text: string): { text: string; chartConfig?: ChartConfig } {
  const candidates = [
    text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1],
    text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed?.visualize === true && Array.isArray(parsed.data)) {
        return {
          text: text.replace(candidate, '').replace(/```(?:json)?|```/g, '').trim(),
          chartConfig: parsed as ChartConfig
        };
      }
    } catch {
      // The response is ordinary Markdown rather than chart JSON.
    }
  }

  return { text };
}

export async function* streamResponseParts(params: GenerateParams): AsyncGenerator<any, void, unknown> {
  if (!(window as any).puter || !(window as any).puter.ai) {
    throw new Error('Puter not loaded');
  }
  const { prompt, history, imageBase64, mode, country, currency } = params;
  let fullPrompt = prompt;
  if (history && history.length) {
    const hist = history.slice(-10).map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n');
    fullPrompt = `${hist}\n\nUser: ${prompt}`;
  }
  const options = buildPuterOptions(params);
  (options as any).stream = true;
  const it = imageBase64 ? (window as any).puter.ai.chat(fullPrompt, imageBase64, options) : (window as any).puter.ai.chat(fullPrompt, options);

  if (it && typeof (it as any)[Symbol.asyncIterator] === 'function') {
    for await (const part of it as any) {
      yield part;
    }
    return;
  }

  const single = await it;
  yield { text: single?.text || String(single) };
}

"""Probe the exact ORICO artifact using native, nongenerating LiteRT scoring."""
import argparse
import json
from pathlib import Path
import time

from jinja2.sandbox import ImmutableSandboxedEnvironment
import litert_lm as lm

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.local-evals/mail-detection-gemma'
MODEL = '/Volumes/ORICO/guarded-llm-models/gemma-4-E2B-it.litertlm'
CACHE = '/Volumes/ORICO/guarded-llm-models/.mail-detection-gemma-cache'


def render(system, user):
    env = ImmutableSandboxedEnvironment(
        trim_blocks=True, lstrip_blocks=True, extensions=['jinja2.ext.do', 'jinja2.ext.loopcontrols'])
    env.globals['raise_exception'] = lambda text: (_ for _ in ()).throw(ValueError(text))
    template = env.from_string((OUT / 'chat-template.jinja').read_text())
    return template.render(messages=[{'role': 'system', 'content': system},
        {'role': 'user', 'content': user}], add_generation_prompt=True,
        bos_token='<bos>', eos_token='<eos>', enable_thinking=False, tools=[])


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--backend', choices=['cpu', 'gpu'], default='gpu')
    args = parser.parse_args()
    Path(CACHE).mkdir(exist_ok=True)
    backend = lm.Backend.GPU() if args.backend == 'gpu' else lm.Backend.CPU(thread_count=4)
    started = time.perf_counter(); results = []
    with lm.Engine(MODEL, backend=backend, max_num_tokens=8192, cache_dir=CACHE,
                   use_ringbuffers_local_attention=False, enable_benchmark=True) as engine:
        print('Engine ready', args.backend, time.perf_counter()-started, flush=True)
        for user in ['What is the capital of France? A: Paris. B: Tokyo. Return A or B.',
                     'What is the capital of France? A: Tokyo. B: Paris. Return A or B.']:
            prompt = render('Answer the question with exactly one letter, A or B. No explanation.', user)
            before = time.perf_counter()
            with engine.create_session(apply_prompt_template=False, max_output_tokens=1) as session:
                session.run_prefill([prompt])
                answers = []
                for label in ['A', 'B']:
                    with session.clone() as branch:
                        answers.append(repr(branch.run_text_scoring([label], store_token_lengths=True)))
                info = session.get_benchmark_info()
                result = {'promptTokens': len(engine.tokenize(prompt)),
                    'answer': answers, 'benchmark': repr(info),
                    'seconds': time.perf_counter()-before}
                print(json.dumps(result), flush=True); results.append(result)
    (OUT / f'smoke-{args.backend}.json').write_text(json.dumps(results, indent=2))


if __name__ == '__main__': main()

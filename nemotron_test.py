from openai import OpenAI

# 1. NVIDIA API 클라이언트 초기화
client = OpenAI(
    base_url="https://integrate.api.nvidia.com/v1",
    api_key="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"
)

# 2. 모델에 요청 (추론 기능 활성화)
completion = client.chat.completions.create(
    model="nvidia/nemotron-3-ultra-550b-a55b",
    messages=[
        {"role": "user", "content": "주식 전략을 파이썬 코드로 변환할 때 발생할 수 있는 가장 흔한 버그 3가지만 알려줘."}
    ],
    temperature=1,
    max_tokens=16384,
    extra_body={
        "chat_template_kwargs": {"enable_thinking": True},
        "reasoning_budget": 16384
    },
    stream=True
)

# 3. 답변 및 추론 과정 출력
print("--- Nemotron 3 Ultra (Thinking Mode) ---\n")
for chunk in completion:
    # 1. 추론 과정(Reasoning) 출력
    reasoning = getattr(chunk.choices[0].delta, "reasoning_content", None)
    if reasoning:
        print(reasoning, end="", flush=True)
    
    # 2. 최종 답변 출력
    if chunk.choices[0].delta.content is not None:
        print(chunk.choices[0].delta.content, end="", flush=True)
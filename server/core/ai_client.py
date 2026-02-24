# server/core/ai_client.py
# AI 统一调用封装

import json
import httpx
import re
from typing import List, Dict, Optional
from sqlalchemy.orm import Session
from server.models import RelationLogic, Config

class AIClient:
    def __init__(self, db: Session):
        self.db = db
        self.config = self._load_config()

    def _load_config(self) -> Dict:
        """从数据库读取AI配置"""
        configs = self.db.query(Config).filter(Config.category == "ai").all()
        return {c.key: c.value for c in configs}

    async def _call_api(self, messages: List[Dict]) -> str:
        """调用OpenAI兼容接口"""
        provider = self.config.get("provider", "deepseek")
        api_key = self.config.get("api_key", "")
        base_url = self.config.get("base_url", "https://api.deepseek.com/v1")
        model = self.config.get("model", "deepseek-chat")

        if not api_key:
            raise ValueError("AI API Key 未配置，请在设置中填写。")

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.3,
            "response_format": {"type": "json_object"} if provider != "minimax" else None
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(f"{base_url}/chat/completions", json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"]

    def _extract_json(self, content: str) -> Optional[Dict]:
        """容错解析 JSON"""
        try:
            # 尝试直接解析
            return json.loads(content)
        except json.JSONDecodeError:
            # 尝试正则表达式提取
            match = re.search(r'\{.*\}', content, re.DOTALL)
            if match:
                try:
                    return json.loads(match.group())
                except:
                    return None
        return None

    async def analyze_sector_pair(self, sector_a: str, sector_b: str) -> Optional[Dict]:
        """分析两个板块之间的关系（注入逻辑模板）"""
        # 1. 获取逻辑词库作为参考
        logics = self.db.query(RelationLogic).all()
        
        # 构建增强版模式列表
        logic_details = []
        for l in logics:
            detail = f"- {l.logic_name}: {l.description}"
            if l.prompt_template:
                detail += f" (思考角度: {l.prompt_template})"
            logic_details.append(detail)
            
        logic_str = "\n".join(logic_details)

        system_prompt = f"""你是A股板块关系分析专家。
请根据提供的【逻辑模式库】分析两个板块是否存在显著的联动关系。

【逻辑模式库】：
{logic_str}

请遵循以下规则：
1. 若无显著关联，hasRelation 设为 false。
2. 若有关联，必须从【逻辑模式库】中选择【最匹配】的一个名称作为 logic_name。
3. 权重 weight 为 -10 到 10 的整数（参考对应模式的默认权重）。
4. 给出简短的分析理由 reason。
5. 只返回 JSON 格式，严格包含: {{"hasRelation": bool, "logic_name": string, "weight": int, "reason": string}}"""

        user_prompt = f"请分析板块A【{sector_a}】与板块B【{sector_b}】是否存在深层逻辑关联。"

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]

        try:
            content = await self._call_api(messages)
            result = self._extract_json(content)
            
            if result and result.get("hasRelation"):
                # 校验 logic_name 是否在库中
                valid_names = [l.logic_name for l in logics]
                if result.get("logic_name") not in valid_names:
                    result["logic_name"] = "其他" # 兜底逻辑
                
                result["source_name"] = sector_a
                result["target_name"] = sector_b
                return result
        except Exception as e:
            print(f"AI分析对 {sector_a}-{sector_b} 出错: {e}")
            
        return None
    async def explain_sector_score(self, sector_name: str, target_date: str, score: float, breakdown_data: List[Dict]) -> str:
        """为板块当前的得分生成大语言模型解释"""
        
        # 组装 Prompt 的基础上下文
        context_str = f"【目标板块】：{sector_name}\n"
        context_str += f"【目标日期】：{target_date}\n"
        context_str += f"【系统评估得分】：{score:.2f} (得分越高，预期上涨动力越强)\n\n"
        context_str += "【得分贡献因子明细】：\n"
        
        if not breakdown_data:
            context_str += "- 无明显的关联板块资金异动支持该板块。"
        else:
            for item in breakdown_data:
                context_str += f"- 关联板块 [{item['related_sector']}] (逻辑：{item['logic_name']}, 权重占比：{item['weight']})，在上一交易日涨跌幅为 {item['daily_change']}%，置信度为 {item['confidence']:.2f}。\n"

        system_prompt = """你是A股超短线板块轮动的分析专家。
你的任务是：根据系统提供的【得分贡献因子明细】（即哪些关联板块的异动导致了该目标板块的当前得分），用极其专业、流畅且富有播报感的财经语言，写一段 100-200 字左右的分析点评。

规则：
1. 不要生硬地罗列数据，要将数据融入到连贯的逻辑推演中（例如：“受上游锂矿板块强势上涨及高置信度资金跟风影响...”）。
2. 如果分数极高，指出最大的拉动引擎；如果分数拖后腿，指出拖累项。
3. 语气要客观中立，带有机构投研的味道。
4. **返回纯文本段落（绝对不要使用任何 Markdown 格式符号，如加粗、星号、列表符、标题等标志符号）**。
5. **不要**有任何免责声明（系统在界面已有提示）。"""

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": context_str}
        ]

        try:
            # 对于解释文本，如果用 minimax 可以不限制 json
            provider = self.config.get("provider", "deepseek")
            api_key = self.config.get("api_key", "")
            base_url = self.config.get("base_url", "https://api.deepseek.com/v1")
            model = self.config.get("model", "deepseek-chat")

            if not api_key:
                return "AI 解释器未激活：请在设置中配置有效的 API Key。"

            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }
            payload = {
                "model": model,
                "messages": messages,
                "temperature": 0.6  # 稍微提高点创造性
            }

            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(f"{base_url}/chat/completions", json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                return data["choices"][0]["message"]["content"]
        except Exception as e:
            return f"生成解释分析时出现网络或接口异常：{str(e)}"

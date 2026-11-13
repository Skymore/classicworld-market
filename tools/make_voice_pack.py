"""Builds the overlay's spoken buff names: frontend/desktop/public/voice/<lang>/<source>.mp3.

A source is a skill ID, or a negative item ID for an item buff (as in the
tracker). Skills: every skill in grind_skills. Items: consumables with a
duration in the Mapledex reference. Korean names come from the game's own
Korean strings (data/reference/cw-client/ko-names.json, exported from the
client's Data/Etc/Language/ko); a skill missing there uses KOREAN below, keyed
by the English name, and the overlay falls back to the English file after that.
Drop names (voice/<lang>/item/<id>.mp3, said after "有好东西掉了"): every item a
monster drops in the Mapledex reference, plus all scrolls, stars and bullets
(which the drop alert always announces), named as the site names them: pass a
JSON file {item id: {zh, en}} exported from the site's items table as the first
argument (otherwise the Mapledex names). An item without a file is read by
Windows speech. Delete a language folder to regenerate it.

Needs edge-tts (Microsoft neural voices, online), which is not a project
dependency: `python -m pip install edge-tts` in a separate environment, then
run this script with that interpreter from the repository root.
"""
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from grind_skills import SKILLS  # noqa: E402

OUT = ROOT / 'frontend/desktop/public/voice'
VOICES = {'zh': 'zh-CN-XiaoxiaoNeural', 'en': 'en-US-JennyNeural', 'ko': 'ko-KR-SunHiNeural'}

KOREAN = {
    'Armor Crash': '아머 크래시', 'Arrow Blow': '애로우 블로우', 'Arrow Bomb: Bow': '애로우 봄', 'Arrow Eruption': '애로우 이럽션',
    'Arrow Rain': '애로우 레인', 'Assaulter': '어설터', 'Avenger': '어벤져', 'Axe Booster': '액스 부스터', 'Axe Mastery': '액스 마스터리',
    'Band of Thieves': '밴드 오브 시브즈', 'Bless': '블레스', 'Blizzard': '블리자드', 'Blunt Weapon Booster': '블런트 웨폰 부스터',
    'Blunt Weapon Mastery': '블런트 웨폰 마스터리', 'Bow Booster': '보우 부스터', 'Bow Mastery': '보우 마스터리', 'Chakra': '차크라',
    'Charged Blow': '차지 블로우', 'Claw Booster': '자벨린 부스터', 'Claw Mastery': '자벨린 마스터리', 'Cold Beam': '콜드 빔',
    'Combo Attack': '콤보 어택', 'Critical Shot': '크리티컬 샷', 'Critical Throw': '크리티컬 스로우', 'Crossbow Booster': '크로스보우 부스터',
    'Crossbow Mastery': '크로스보우 마스터리', 'Dagger Booster': '대거 부스터', 'Dagger Mastery': '대거 마스터리', 'Dark Sight': '다크 사이트',
    'Disorder': '디스오더', 'Dispel': '디스펠', 'Doom': '둠', 'Double Shot': '더블 샷', 'Double Stab': '더블 스탭',
    'Dragon Blood': '드래곤 블러드', 'Dragon Fury': '드래곤 퓨리', 'Dragon Roar': '드래곤 로어', 'Drain': '드레인',
    'Element Amplification': '엘리멘트 앰플리피케이션', 'Element Composition': '엘리멘트 컴포지션', 'Energy Bolt': '에너지 볼트',
    'Explosion': '익스플로젼', 'Final Attack: Axe': '파이널 어택 액스', 'Final Attack: Blunt Weapon': '파이널 어택 둔기',
    'Final Attack: Bow': '파이널 어택 활', 'Final Attack: Crossbow': '파이널 어택 석궁', 'Final Attack: Polearm': '파이널 어택 폴암',
    'Final Attack: Spear': '파이널 어택 창', 'Final Attack: Sword': '파이널 어택 검', 'Fire Arrow': '파이어 애로우',
    'Fire Charge': '파이어 차지', 'Flash Jump': '플래시 점프', 'Focus': '집중', 'Golden Eagle': '골든 이글', 'Haste': '헤이스트',
    'Heal': '힐', 'Holy Arrow': '홀리 애로우', 'Holy Symbol': '홀리 심볼', 'Hyper Body': '하이퍼 바디', 'Ice Charge': '아이스 차지',
    'Ice Strike': '아이스 스트라이크', 'Inferno': '인페르노', 'Invincible': '인빈서블', 'Iron Arrow: Crossbow': '아이언 애로우',
    'Iron Body': '아이언 바디', 'Iron Will': '아이언 월', 'Keen Eyes': '킨 아이즈', 'Lightning Charge': '썬더 차지',
    'Lucky Seven': '럭키 세븐', 'MP Eater': 'MP 이터', 'Magic Armor': '매직 아머', 'Magic Claw': '매직 클로', 'Magic Guard': '매직 가드',
    'Meditation': '메디테이션', 'Meso Explosion': '메소 익스플로젼', 'Meso Guard': '메소 가드', 'Mystic Door': '미스틱 도어',
    'Nimble Feet': '님블 피트', 'Panic': '패닉', 'Pickpocket': '픽파킷', 'Poison Mist': '포이즌 미스트', 'Polearm Booster': '폴암 부스터',
    'Power Crash': '파워 크래시', 'Power Guard': '파워 가드', 'Power Knockback': '파워 넉백', 'Power Strike': '파워 스트라이크',
    'Puppet': '퍼펫', 'Rage': '분노', 'Recovery': '리커버리', 'Rush': '러시', 'Savage Blow': '새비지 블로우', 'Seal': '씰',
    'Shadow Meso': '섀도우 메소', 'Shadow Partner': '쉐도우 파트너', 'Shadow Web': '쉐도우 웹', 'Shout': '샤우트',
    'Silver Hawk': '실버 호크', 'Slash Blast': '슬래시 블러스트', 'Slow': '슬로우', 'Soul Arrow: Bow': '소울 애로우 활',
    'Soul Arrow: Crossbow': '소울 애로우 석궁', 'Spear Booster': '스피어 부스터', 'Spell Booster': '스펠 부스터', 'Steal': '스틸',
    'Strafe': '스트레이프', 'Summon Dragon': '서먼 드래곤', 'Sword Booster': '소드 부스터', 'Teleport': '텔레포트', 'Threaten': '위협',
    'Three Snails': '달팽이 세마리', 'Thunder Bolt': '썬더 볼트', 'Thunder Spear': '썬더 스피어', 'Wind Step': '윈드 스텝',
}


WARNINGS = {'hp_low': {'zh': '血量低', 'en': 'Low HP', 'ko': '체력 부족'},
            'drop_alert': {'zh': '有好东西掉了', 'en': 'Valuable drop', 'ko': '좋은 아이템이 떨어졌어요'}}


def lines():
    """(lang, source, text) for every file of the pack (a source is also a warning's name)."""
    for name, texts in WARNINGS.items():
        for lang, text in texts.items():
            yield lang, name, text
    game = json.loads((ROOT / 'data/reference/cw-client/ko-names.json').read_text(encoding='utf-8'))
    for skill, (zh, en) in SKILLS.items():
        yield 'zh', skill, zh
        yield 'en', skill, en
        ko = game['skills'].get(str(skill)) or KOREAN.get(en)
        if ko:
            yield 'ko', skill, ko
    items = json.loads((ROOT / 'data/reference/mapledex/items.json').read_text(encoding='utf-8'))['items']
    korean = json.loads((ROOT / 'server/crates/market-web/src/i18n/ko-game.json').read_text(encoding='utf-8'))['items']
    for item in items:
        if item.get('type') != 'consume' or not item.get('time'):
            continue
        names = item['n']
        yield 'zh', -item['id'], names.get('cw') or names.get('zh') or names['en']
        yield 'en', -item['id'], names['en']
        ko = game['consumables'].get(str(item['id'])) or korean.get(str(item['id']))
        if ko:
            yield 'ko', -item['id'], ko


def drop_names():
    """(lang, 'item/<id>', text) for the items the drop alert can name."""
    korean = json.loads((ROOT / 'server/crates/market-web/src/i18n/ko-game.json').read_text(encoding='utf-8'))['items']
    site = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')) if len(sys.argv) > 1 else {}
    seen = set()
    for kind in ('equips', 'items'):
        for item in json.loads((ROOT / f'data/reference/mapledex/{kind}.json').read_text(encoding='utf-8'))['items']:
            if item['id'] in seen or not (item.get('droppedBy') or item['id'] // 10000 in (204, 207, 233)):
                continue
            seen.add(item['id'])
            names = item['n']
            ours = site.get(str(item['id'])) or {}
            names = dict(names, cw=ours.get('zh') or names.get('cw'), en=ours.get('en') or names.get('en'))
            source = f"item/{item['id']}"
            if names.get('cw') or names.get('zh'):
                yield 'zh', source, names.get('cw') or names['zh']
            if names.get('en'):
                yield 'en', source, names['en']
            if korean.get(str(item['id'])):
                yield 'ko', source, korean[str(item['id'])]


async def main():
    import edge_tts
    todo = [row for row in [*lines(), *drop_names()] if not (OUT / row[0] / f'{row[1]}.mp3').exists()]
    for lang in VOICES:
        (OUT / lang / 'item').mkdir(parents=True, exist_ok=True)
    gate = asyncio.Semaphore(6)

    async def make(lang, source, text):
        async with gate:
            target = OUT / lang / f'{source}.mp3'
            await edge_tts.Communicate(text, VOICES[lang], rate='+10%').save(str(target) + '.part')
            Path(str(target) + '.part').replace(target)
    await asyncio.gather(*(make(*row) for row in todo))
    print(f'{len(todo)} files written to {OUT}')


if __name__ == '__main__':
    asyncio.run(main())

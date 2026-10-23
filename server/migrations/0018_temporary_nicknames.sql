-- Stable, non-personal aliases for collectors who have not chosen a name.
-- Existing custom names and explicit leaderboard opt-outs are preserved.
CREATE FUNCTION temporary_contributor_nickname() RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  adjectives text[] := ARRAY['悠闲的','勇敢的','快乐的','机灵的','勤快的','幸运的','热心的','好奇的','温柔的','冷静的','活泼的','认真的','爱笑的','开心的','自信的','潇洒的','善良的','可爱的','灵巧的','坚强的','勤奋的','安静的','调皮的','慢悠悠的','闪亮的','神气的','淘气的','乐观的','害羞的','优雅的','敏捷的','英勇的','聪明的','自在的','友善的','可靠的','纯真的','暖心的','豪爽的','俏皮的','勇往直前的','兴高采烈的','无忧无虑的','心灵手巧的','朝气蓬勃的','精神抖擞的','大方的','文静的'];
  monsters text[] := ARRAY['蜗牛','蓝蜗牛','红蜗牛','绿水灵','绿蘑菇','花蘑菇','蓝蘑菇','刺蘑菇','木妖','斧木妖','石头人','野猪','火野猪','黑斧木妖','青蛇','蝙蝠','僵尸蘑菇','猴子','风独眼兽','冰独眼兽','火独眼兽','青龙','火焰龙','土龙','白狼','灰狼','黑石头人','蘑菇王','漂漂猪','黑木妖','小企鹅王','企鹅王','雪人','白雪人','星光精灵','月光精灵','日光精灵','小雪人','玩具熊','粉红玩具熊','发条熊','玩具木马','积木怪','小海豹','小丑鱼','海马','章鱼','小幽灵'];
  candidate text;
BEGIN
  FOR attempt IN 1..32 LOOP
    candidate := adjectives[1+floor(random()*array_length(adjectives,1))::integer] || monsters[1+floor(random()*array_length(monsters,1))::integer];
    EXIT WHEN NOT EXISTS(SELECT 1 FROM collectors WHERE nickname=candidate)
          AND NOT EXISTS(SELECT 1 FROM accounts WHERE nickname=candidate);
  END LOOP;
  RETURN candidate;
END $$;
ALTER TABLE collectors ADD COLUMN nickname_temporary boolean NOT NULL DEFAULT true;
ALTER TABLE accounts ADD COLUMN nickname_temporary boolean NOT NULL DEFAULT true;
UPDATE collectors SET nickname_temporary=false WHERE nickname<>'';
UPDATE accounts SET nickname_temporary=false WHERE nickname<>'';
UPDATE collectors SET nickname=temporary_contributor_nickname(),listed=true WHERE nickname='';
UPDATE accounts SET nickname=temporary_contributor_nickname(),listed=true WHERE nickname='';
ALTER TABLE collectors ALTER COLUMN nickname SET DEFAULT temporary_contributor_nickname();
ALTER TABLE accounts ALTER COLUMN nickname SET DEFAULT temporary_contributor_nickname();
ALTER TABLE collectors ALTER COLUMN listed SET DEFAULT true;
ALTER TABLE accounts ALTER COLUMN listed SET DEFAULT true;

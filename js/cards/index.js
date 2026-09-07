/**
 * 卡牌系统入口聚合
 * ------------------------------------------------------------------
 * PlayingState 只从这里 import CardSystem。
 * 新增卡牌：新建派生类文件后，在下方加一行 import + registerCard 即可，
 * 工厂（CardSystem.createCard）与其余逻辑零改动。
 */
import { CardSystem, registerCard } from './cardSystem.js';
import { ClearHalfCard } from './clearHalfCard.js';
import { ShrinkAllCard } from './shrinkAllCard.js';
import { ForceLevelCard } from './forceLevelCard.js';
import { NoCollideCard } from './noCollideCard.js';
import { RandomForceCard } from './randomForceCard.js';
import { SplitFruitCard } from './splitFruitCard.js';
import { MultiShotCard } from './multiShotCard.js';
import { FreezeZombieCard } from './freezeZombieCard.js';
import { FreezeSnakeCard } from './freezeSnakeCard.js';

registerCard('clear_half', ClearHalfCard);
registerCard('shrink_all', ShrinkAllCard);
registerCard('force_level', ForceLevelCard);
registerCard('no_collide', NoCollideCard);
registerCard('random_force', RandomForceCard);
registerCard('split_fruit', SplitFruitCard);
registerCard('multi_shot', MultiShotCard);
registerCard('freeze_zombie', FreezeZombieCard);
registerCard('freeze_snake', FreezeSnakeCard);

export { CardSystem };

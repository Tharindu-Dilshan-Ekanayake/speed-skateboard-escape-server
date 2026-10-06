/**
 * Sanity checks for the generated maps: every stage must be clearable at its
 * recommended level, and the economy curve is printed for a quick eyeball.
 */
import { AIR_TIME, RECOMMENDED_LEVEL, moveSpeedFor, speedForLevel } from '../src/shared/config.js'
import { getWorlds } from '../src/shared/layout.js'

let failed = false
for (const layout of getWorlds()) {
  console.log(`\nWorld ${layout.world + 1}: length ${Math.round(layout.length)}m, boxes ${layout.boxes.length}, wedges ${layout.wedges.length}, rails ${layout.rails.length}`)
  for (const st of layout.stages) {
    const v = moveSpeedFor(st.rec, 1)
    const reach = v * AIR_TIME
    const ok = st.gap < reach
    if (!ok) failed = true
    console.log(
      `  stage ${String(st.stage).padStart(2)} rec L${String(st.rec).padStart(2)} len ${String(Math.round(st.zStart - st.zEnd)).padStart(3)}m  gap ${st.gap.toFixed(1)}m / jump ${reach.toFixed(1)}m ${ok ? 'ok' : 'TOO WIDE'}`,
    )
  }
}
console.log('\nLevel curve (rebirth 0 / 1 / 3):')
for (const l of [1, 5, 10, 15, 20, 25]) console.log(`  L${l}: ${speedForLevel(l, 0)} / ${speedForLevel(l, 1)} / ${speedForLevel(l, 3)}`)
console.log(`\nRecommended levels: ${JSON.stringify(RECOMMENDED_LEVEL)}`)
if (failed) process.exit(1)

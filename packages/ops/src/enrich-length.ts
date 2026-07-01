import { Dataset, defineTransform } from '@databench/engine'
import { pythonWordCount, sampleText } from './text.js'

export const enrichLength = defineTransform(
  { name: 'enrich_length', version: '1' },
  (dataset: Dataset) => {
    const samples = Array.from(dataset.toSamples(), (sample) => {
      const text = sampleText(sample)

      sample.signals = {
        ...sample.signals,
        // Count Unicode code points (matching Python `len(str)`), NOT
        // `text.length` (UTF-16 code units) — otherwise astral characters
        // (emoji, CJK ext-B) inflate the count and diverge from Python.
        char_len: [...text].length,
        word_len: pythonWordCount(text),
      }

      return sample
    })

    return Dataset.fromSamples(samples, dataset.name)
  },
)

# Third-party notices

## EvalScope

Databench's Evaluation implementation is designed as a modified port of the React user interface and an integration
with the Python service from [ModelScope EvalScope](https://github.com/modelscope/evalscope).

- Upstream commit: `b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60`
- Copyright: Alibaba ModelScope contributors
- License: Apache License 2.0
- Upstream license digest: `2bfd8cd37a4dd0fc55332c7d21050ab071a1843324c39af2434dab94cbf38f72`

The full Apache License 2.0 text is available from the upstream repository and at
<https://www.apache.org/licenses/LICENSE-2.0>. Files ported in later implementation steps must retain applicable
copyright and modification notices. EvalScope and ModelScope names and logos are not relicensed as Databench brand
assets.

## Plotly.js

The offline report renderer pins and ships Plotly.js `2.35.2`, distributed under the MIT License.

- Asset SHA-256: `6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603`
- Vendored license: `deploy/evalscope/vendor/plotly-LICENSE.txt`
- License: <https://github.com/plotly/plotly.js/blob/v2.35.2/LICENSE>

## NLTK Punkt tokenizer data

The EvalScope image ships the NLTK `punkt_tab` tokenizer data required by EvalScope's built-in BLEU, ROUGE and
instruction-following metrics. The package identifies Jan Strunk as its author and documents the training corpora and
model contributors in its bundled `README`. The NLTK package index does not declare a separate license field for this
data package; downstream distribution therefore retains the package unchanged with its README and source metadata.

- Package SHA-256: `e57f64187974277726a3417ca6f181ec5403676c717672eef6a748a7b20e0106`
- Source package: <https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/tokenizers/punkt_tab.zip>
- Package metadata: <https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/index.xml>
- NLTK data licensing notice: <https://www.nltk.org/data.html>

Additional third-party notices introduced while source is ported must be appended before the corresponding Step can
pass its gate.

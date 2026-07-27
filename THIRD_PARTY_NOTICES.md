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

The planned offline report renderer pins Plotly.js `2.35.2`, distributed under the MIT License. E0 records the
expected asset digest; the bytes and license text are not shipped until the E3 backend image step.

- Asset SHA-256: `6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603`
- License: <https://github.com/plotly/plotly.js/blob/v2.35.2/LICENSE>

Additional third-party notices introduced while source is ported must be appended before the corresponding Step can
pass its gate.

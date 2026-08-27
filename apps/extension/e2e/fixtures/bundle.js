// Nothing in the served HTML says this; only a live-DOM capture will see it.
document.getElementById('root').innerHTML =
  '<section class="card"><h2>Rendered by client JS</h2>' +
  '<button type="button">Load more</button></section>';

// Images that load only once scrolled into view — the IntersectionObserver
// pattern that made a real capture hang, and the reason the worker performs its
// own scroll pass before serializing.
const list = document.getElementById('gallery');

for (let i = 0; i < 12; i++) {
  const li = document.createElement('li');
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.width = 32;
  img.height = 32;
  img.alt = `image ${i}`;
  img.dataset.src = `/hero.png?i=${i}`;
  li.append(img);
  list.append(li);
}

const observer = new IntersectionObserver((entries, obs) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.src = entry.target.dataset.src;
    obs.unobserve(entry.target);
  }
});

for (const img of list.querySelectorAll('img')) observer.observe(img);

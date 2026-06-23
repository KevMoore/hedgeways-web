export function showHowTo(): void {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal howto">
      <h2>How to play Hedgeways</h2>
      <p>You are farmers competing for land. Use hedges as boundaries to enclose fields.
         Each time you enclose a field you score a point for every empty square inside it
         (an acre of land).</p>
      <ul>
        <li>On your turn, lay <b>1, 2 or 3</b> hedges.</li>
        <li>Hedges must be <b>linked by colour</b> &mdash; every touching segment must match
            colour, both to existing hedges and to each other.</li>
        <li>The very first turn is exempt from linking to existing hedges.</li>
        <li>Diagonally touching hedges do <b>not</b> enclose a field.</li>
        <li>No hedges may be laid inside an already-enclosed field.</li>
        <li>After your turn you replenish back to 4 hedges.</li>
      </ul>
      <p><b>The game ends</b> when a farmer lays their last hedge. The winner has enclosed
         the most acres of land!</p>
      <button class="btn primary" id="howto-close">Got it</button>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.querySelector("#howto-close")!.addEventListener("click", close);
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
}

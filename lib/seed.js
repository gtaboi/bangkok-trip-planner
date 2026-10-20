'use strict';
// Seed ideas inserted on first run: [title, category, area, duration, cost, description, image]
const SEED = [
  ['Grand Palace, Wat Phra Kaew & Wat Pho', 'Culture', 'Rattanakosin', 'Half day', '฿500–700 pp', 'The Emerald Buddha, the royal palace complex, and the giant Reclining Buddha. Dress code: covered shoulders and knees. Go early to beat heat and crowds.', 'wiki:Grand_Palace'],
  ['Wat Arun at sunset + Chao Phraya boat', 'Culture', 'Thonburi / Riverside', '3–4 hours', '฿200 pp', 'Cross by ferry to the Temple of Dawn, climb the prang, then ride the orange-flag river boat as the sun goes down.', 'wiki:Wat_Arun'],
  ['Chatuchak Weekend Market', 'Shopping', 'Chatuchak', 'Half day (Sat/Sun)', 'Bring cash', '15,000+ stalls: clothes, antiques, plants, coconut ice cream. Arrive by 10am and set a meeting point.', 'wiki:Chatuchak_Weekend_Market'],
  ['Yaowarat (Chinatown) street-food crawl', 'Food', 'Chinatown', 'Evening', '฿500–800 pp', 'Neon signs, Michelin-listed stalls, guay jub, toasted buns, seafood. Best after 6pm.', 'wiki:Yaowarat_Road'],
  ['Damnoen Saduak Floating Market + Maeklong Railway Market', 'Day trip', 'Ratchaburi / Samut Songkhram', 'Full day', '฿1,200–1,800 pp (tour)', 'Boat ride through the floating market, then watch the train roll through the market stalls at Maeklong.', 'wiki:Damnoen_Saduak_floating_market'],
  ['Ayutthaya ancient capital day trip', 'Day trip', 'Ayutthaya', 'Full day', '฿1,000–2,000 pp', 'UNESCO temple ruins, the Buddha head in tree roots at Wat Mahathat. Train, van, or private driver; rent bikes on site.', 'wiki:Wat_Mahathat_(Ayutthaya)'],
  ['Muay Thai night at Rajadamnern Stadium', 'Nightlife', 'Pom Prap', 'Evening', '฿2,000+ pp', 'Live Thai boxing at the historic stadium. Ringside or club seats for a group.', 'wiki:Rajadamnern_Stadium'],
  ['Rooftop bar evening (Sky Bar / Octave / Tichuca)', 'Nightlife', 'Silom / Sukhumvit', 'Evening', '฿600–1,000 pp', 'Skyline views and cocktails. Smart-casual dress code; book a table for 10.', 'wiki:Lebua_at_State_Tower'],
  ['Thai cooking class + local market tour', 'Food', 'Silom / Sukhumvit', 'Half day', '฿1,200–1,800 pp', 'Shop a wet market with a chef, then cook 4–5 dishes (pad thai, green curry, mango sticky rice).', 'wiki:Pad_thai'],
  ['Jim Thompson House + Siam shopping', 'Culture', 'Siam', 'Half day', '฿200 + shopping', 'Teak-house museum of the silk king, then MBK, Siam Paragon and Siam Square One.', 'wiki:Jim_Thompson_House'],
  ['ICONSIAM + Asiatique riverfront night', 'Shopping', 'Riverside', 'Afternoon–evening', 'Free entry', 'Indoor floating market (SookSiam) at ICONSIAM, then the Asiatique Ferris wheel and night bazaar.', 'wiki:Asiatique'],
  ['Bang Krachao "Green Lung" bike tour', 'Outdoors', 'Bang Krachao', 'Half day', '฿100 bike rental', 'Cross the river by longtail and cycle elevated paths through jungle, orchards, and a weekend market.', 'wiki:Bang_Kachao'],
  ['Traditional Thai massage at Wat Pho school', 'Wellness', 'Rattanakosin', '1–2 hours', '฿420–600 pp', 'The birthplace of Thai massage. Pair with the Grand Palace morning, or book a spa afternoon for the group.', 'wiki:Thai_massage'],
  ['Khao San Road night out', 'Nightlife', 'Banglamphu', 'Evening', '฿500+ pp', 'Backpacker street with bars, street food, and live music. Rambuttri Alley is a calmer alternative.', 'wiki:Khaosan_Road'],
  ['Erawan Museum + Ancient City (Muang Boran)', 'Culture', 'Samut Prakan', 'Full day', '฿700–1,000 pp', 'A three-headed elephant museum, then an open-air park of Thai landmarks you explore by golf cart or bike.', 'wiki:Erawan_Museum'],
  ['Safari World & Marine Park', 'Family / fun', 'Khlong Sam Wa', 'Full day', '฿1,500 pp', 'Drive-through safari plus animal shows. A good pick if the group wants something lighthearted.', 'wiki:Safari_World'],
  ['Jodd Fairs night market', 'Food', 'Rama IX', 'Evening', '฿300–600 pp', 'Volcano ribs, grilled seafood, and bars; easy to reach by MRT.', null],
  ['Lumpini Park morning + Sukhumvit brunch', 'Outdoors', 'Lumpini / Sukhumvit', 'Morning', '฿400 pp', 'Jog or walk with the monitor lizards, then a long brunch in Thonglor or Ekkamai.', 'wiki:Lumphini_Park'],
];

module.exports = { SEED };

/* MesoWatch live reader, part B: frame capture and shop-window finder (beta, FEATURES.liveReader).
 *
 * window.MesoLiveCapture = { start(stream, onShop, opts) -> stop(), findShop(imageData), frames() (the last 6 frames read, for a report) }
 *
 * Ported ideas (not code) from the laptop's maple_market/shop_capture.py (engine shop-capture-v1):
 *  - find the buyer window by normalised correlation of its header against two fixed templates
 *    (player store, hired merchant), on a 320 px wide grey frame, over a sweep of UI scales,
 *    with a 160 px prescreen;
 *  - require the pale listing panel (median brightness >= 170, median saturation <= 60);
 *  - the listing area is split into 6 row bands; a band is a row when it shows an icon and text.
 * Templates: the laptop's header templates (Athyris public VOD, 640x360 space), half size, grey, base64.
 * Nothing leaves the PC: this file only reads pixels and calls the page's callbacks.
 * Plain browser JS, no libraries. Also loads in node (module.exports) for tests.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- templates (640-space geometry)
  var TPL = {"player": {"fullW": 246, "fullH": 214, "headH": 62, "w": 123, "h": 31, "lst": [0, 68, 110, 195], "b64": "qsLDwcLAv7/AwMHBwcHBwMHBwcHBwcC/v8DAvr7CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLBwcHBwcHBwcHBwcHBwcHBv7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7++vr6/v8DBwsTEwsHBwcHCxMTEw66CsOHh8P39/v7+/v////72/f39/f39/f388/7+/Pz////////////////////////////////+/v7+/v7+/v///////////f39/f39/f39/f39/f39/f7+/v7+/v7+/f39/f39/f3+/v7+/v7//v39/f79/f39/f3n2cSYr/n958DA3bi6w7jCxNOivMfM3sa3wM+mp8vOsqTHtMm7zJW9+eLDvcvK3LrrzLXKsuCy97DH5abG0s+TwLX8+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/z8/Pz8/Pz8+/v7+/v7+/z9/f39/Pz8/Pz8/Pv7+/v7+/z7+7y9r/7+6MGzr6+stqu9u8TCsabfv5Syu7Grl66pyby5i6q8uZia6eamlqmVoorc0b64ncGt86+m+Lqipq2hubn9/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/P39/f39/f39/Pz8/Pz8/Pz9/f39/fz8/P38/Pz8/Pz9/f38/L6pr+3v6Pvu+/D79/j5uuP38/b6+fb3+Pnv9vHx+Pj37Pf38/Pr7fv88PDx+O78+vr26+e1/e/6/fL47Pbw8/P8/fz8/Pz+//////////39/f39/f39/v39/f39/f39/f39/f39/f3+/v7+/v7+//39/f39/f39/f3368Ciq93f5vLz8/Lx8fHy7/Lw7/Dw8fLy8fHx7/Ly8fHw7/Dw8fLy8/Lx8vLz8/Lz8vLx8fX08PHy7/Px8vPy8vDu7+7u7u7v8fLy8vLy8vHv7u7u7u7v8O/v7+/v7+/v7+7u7u7u7u7v7u7u7u7u7+3t7e3t7e3u7u/r4biWqq2wq6ysrKysrKysrKyrq6urq6utrq+vrq2srKysrKysrKysrKysrKysrKysrKysq6mpr6unqayur66trKysrKysrKysq6qqqqqqqqqpqKioqKipqaqqqqqqqqqqqamoqKioqKmqqqurq6urq6urq6urq6urra6vrqiYrK27vLu5t7e3t7e3t7e3t7e3t7e4ubq6ubi3t7e3t7e3t7e3t7e3t7e3t7e3t7e3uLm6tbiqrq23uLm6u7u7u7u7u7u7vb29vb29vbu7urq6urq7u7y8vLy8vLy8u7u6urq6uru6urq6urq6u7u7u7u7u7u7u7u5r7Cdrcvr7Ozq6Ofm5ubm5ubm5ubm5ubm5ubm5ubm5ubo6Ojo6Ojo6Obm5ubm5ubm5ubm5ubm5LmurMvn6Ojo6Onp6enp6enp6Ojo6Ojo6Ojo6Ojo6Ojo6Onp6enp6enp6Ojo6Ojo6Ojp6enp6enp6enp6enp6enp6Ojm0a99rc/s7e3t7u7t7e3t7e3t7e3t7e3t7e3u7e7u7u7u7u/v7+/u7u7u7u7u7u7u7u7u7u7s6cSurNPt7+/v7+/v7+/v7+/v7e3t7e3t7e7t7e3t7e3t7u7u7u7u7u7u7e3t7e3t7e3u7u7u7u7u7u3t7e3t7e3t7u7t2auArMzm6enp6enp6enp6erq6urq6urq6uzt5+rr7O3r7Ozs7ezs6+zs7Ozs7Ozs7Ozs7Ozs68SurNTq6urq6urq6urq6urq6uvq6+rq6urq6urq6urq6uvr6+vr6+vr6urq6urq6urr6+vr6+vr6+zs7Ozs7Ozs7Ovp2ayErcjg5OTk4+Pj4+Tj4+Tk5OTk4+Pj5OTj2+Dg4eLi4uLi4+Hg4OHh4eHh4eHh4eHh4ODh5sCurNDk5OTk5OXl5eXl5eTk4uPk5eXl5eTk5OTk5OTk5OTk5OTk5OTk4+Pj4+Pj4+Pi4eDg4ODg4ODg4ODg4ODg4uLj1ap8rMbf4uLi4eHg4eTf4OHh4ODg4ODg4ODg197e3t7e3t/f39/g4ODg4ODg4ODg4ODg4ODh4L+uq8/g4eHh4eDg3+Ph49ze3Nzk5OLi4eHh4eHh4eHh4eLi4uLi4uLi4ODg4ODg4ODg39/f39/f39/f39/f39/f3+Di061ur8jf3+Dg3+Di5N+3r6rM3d7f4ODg4ODg2N/f39/e3t7eycG5ubm5ubm5ubm5ubm5ubi5zsCuq8/f4ODg4N/f0JFncq/Im77OzuHh4ODg3t7e3t7e3t/f39/f39/f39/f39/f397e3t7e3t7e3uDg4ODg4N/g4OHi069srcjf39/f3t7boI/Q4ebLsNbf4ODg39/f1t3d3d3d3d3dd5OUlJKSj4+Pjo2NjY2NjYyMib+tq87e3t7f4N6LMS8iFyVDVK5t2ODg39/d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3f3+Hi065qqsnf3t7d3dugncLl+fn6+Krd4ODg39/e1d3d3d3d3d3dhqyqrK6tp6mtqq2trq2traurlcWtq87d3d2rjYNmGA8+JhsdHyyh6ODg39/d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3e3+Hi061rssne3d3d3dhwjLzn8vr788i23+Dg39/e1d3d3d3d3d3dhb69vbq5ubm5ubm5uLi4uLm8nsSxsc7d3dzaiVabBwpQe0USGSc+UXCu3t/d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3+Hh066FsMnd3N3d3duAi7TMuJCGmMeq3uDg39/d1N3d3d3d3d3dkZmampqZmpqam5ubmpqamZufr7q0p87d3d7fv2haGkk/doAPCQhFSZ3b3d/d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3+Hg0qyn1srd3N3d3eGlm6lsNFOSaDmU4eDg39/d1N3d3d3d3d3d3d3d3uDc4ODg4ODg4ODg39vh3s/N0s7d3d2WOSArSU0wHU0MCwtI1N/b3d/d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3+Df0c2N1sre3d3d3eGlkIJ2LnrcUUqI4OHg39/d1N3d3d3d3d3d3dzc3dbA29zc29vb29vb3L3e38/N0s7d3d3arBcWLlGQCCQOAQQVGY7e39/d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3t/ez9iC1cre3d3d3t3Md2jPnNPowV+73eDg393c093d3d3d3d3d29zb2tfY2tfX19bX19fW2Nrc3svM0s7d3d2xTkgRasXkYGURF1o9vt7j4N/d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3+Df1NJq1sre3d3d3d7fvVSEzOTHwb7e4ODg393c093d3d3d3d3de3l4eXt9fXt6eHh5eHl5eXh3hsvM0s7d3d7j5M5k0PHp5OJGG1m74N7e39/d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3+Df1NN718rd3d3d3d3f38iApmZ3i97e39/f393c093d3d3d3d3deI6Oj5KVjpqUkpmclZiXkZOSjNDM0s7d3d3d3d7duHSOoVEYZcjd3t3d3t/d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3+Df1NRy1srd3d3d3uDf36qPzYa7xOLi3t/f393c093d3d3d3d3dfqGioqetpaOloqqnoKKloKCjk8rM0s7d3d3d3d3e4a+LlYCZ293d3N3d39/d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3+Df1NRy18rd3dzd4ODYxpd35Ji4h9/d3t/f393c093d3d3d3d3dhpmVlpWVlZWVlZWVlpaWlpWWo83M0s/b3d3d3d7e4JjB4Jmqqdbc2tzf39/d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d39/e1NZv18rd3dze3t/Kf+ilnoaY0LLd3t/f393c093d3d3d3d3dvrSzsrKysrKysrKysrKysrKyxczM0s/a3N3d3t3duYItIiK1r43o2d3e39/d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3+Df1NNt1cvd3eDd4qO+0pjA7dyQisjb4ODg393c093d3d3d3d3ddYWDfYOGgYaDgYWDhIGAgIOGgM7M0tDb3N3h3+HcoVVfo2bInr7c4N7e39/d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3+Df1NWP2Mvd3d7socDb6+r0//z2oqXg4ODg3t3c093d3d3d3d3de5Kem6Cno56ilp+co6KfnZycjM7M0tDb3N7c06ycnLCRaXupxd3i29ze39/d3d3d3d3d3d3d3d3d3d3e3d7d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3+Df1NOR2Mze3N3HgrCQrs7V4OLkmqfl4ODf3tzc093d3d3d3d3dgK2yrK6urq6tra2trq6urq2ul83M087d3d3a1LewwIRgTxeZ1uDg3t/f39/d3d3d3dzc2dfS09LT2Njc3d/e3d3d3d3d3d3e2djX1tbV1dnc4N3d3d7f0NOO2M3e3d/Wk4N0dMueoJZxi9Pe4N/f3t3b093d3N3d3d3dlZeVlpmampmZmZmZmZmZmZmYs87N0s3d3d7h06yahElASjtpnK/S3t3d3d7c3d3d3dKrmZOMiouPlZin0t3d3d3d3d3d3d3CnpSRkJCOj5Oixdzc3d7f0NKP183X1NXW2tfgqJJ9jKnN09TV2drZ2Nrc093V0M/V2M3Ozs/P0NDQ0NDQ0NDP083RztHN3MrN083W19bX19XQz87NzM3Q1NXW1tbW2Nfb0tDQ0dHQzsrIyMjIycvN0dPT09Lc2NDS0tPS0tDJyMjIyMnOz8/Pz8/S1NKP"}, "hired": {"fullW": 215, "fullH": 173, "headH": 50, "w": 108, "h": 25, "lst": [0, 55, 105, 172], "b64": "rrCvr6+trKmrq656VnuTcZSurK6ura2tra2tra2tra2tra2tra2tra2tra2tra6urq6up6mqraanqaqsrKysoHR9hp+hfLSXrKqpqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpq2orMvo6Obm4eXe0H2YcGddUbnh5OXl5OPj4+Pj4+Pk5OPm5uXm5eXl5eXl5eXl5eXl5ebk26yrrNPl5OPn5tV9JzcaID1fka2H5uPi4ePj4eHh4eHh4ePj4+Pj4+Pj4+Pj4+Pj4+Pk5OXl2aqgptrq6+vs7OzulUdEQE6UhY/t6enq6+zt7Ozs7Ozs6+rqmZGRkZCPj4+Ojo+Pj4+PjoqOurKtq+bq6PGMv3JIBjYuJRwbM0/h5+fq8O3q6+vr6+vr6+vq6urq6urr6urq6urq6urq6+vr6a6irNjp6urp6OnqdcF4tqyLVlHP7Ozt7e3u7u3t7e3t7ezoiba1tbSzs7S1tLS1sra2trS1n7Kuq+Lq6uu6SaQxAShqURgNJEdmkqHj6enq6+vr7O3t7e3s7e3t7e3t7Ozs7Ozs7Ovs7O3t6rCirdfk5ebj4ttrbJbNWXqGZDXU5eXl5OLi4uPk5OTl5uffjL+/urm5ubi2tLK5s7u5uLm8orKtqt3i4uPuc6geNThMtC8JFBszS7jq4uTk5OPj4uLi4uPj4+Pk5OTj4+Hh4eHh4uHi4+Tk5rCirNbk4+Ph3rdlu2s7nb90QU7I4eHg4N/f39/f39/f3t7Vj8TFwr++vr6/v8HFvr2+wMHDqbOtqtvf3dF/LEEmQ0cfSDQHCxyt6+Dd4tvi3t3d3d3d3d3f4N3e3t7e3d3d3d3d3d3d3t/j5rCiq9fj4+Lg3txuZHDEbKBStYaz4eDg4ODf39/f39/f397htLGxsK+urq6urq6urq6usK6z0LOsqtzg4N2yXiwYLXw4Ey8FDAkMU87e5N/e3d3d3d3d3dva2tra2trb2tnZ2dnZ2dnZ2tzW5K+iqdbj4+Pg3uCp0MJ7wKLk1ZXT4ODg4ODf39/f39/f393Ya3FxcHFxcXFwcHFxc29xcXNuoLatqtzf39Z8ORMyXeGwNCsDURyDvdff4uHf3t3d3d3d3t/LaHJ0dHNycW1wcnRzcnJ1dXNstK+irtfi4uLg29vSqNLP89PTn7zg3+Dg4ODf39/f39/f3t3UbIyMjJSUjpSNk5eYl5GUkI+KoLetqtvf3t/d2m2D6env3pA0JX3J4OLd3+Hg393d3d3d3t/EbY6PkJGSlZGUlpiVk5SVkI+GtLChr9bg4eDcrIyCPzZrVzBstqfe39/f39/e3t7e3t7e39/ReJycnKOhnqSgo6GnpaSjn52bp7Wtsdre3trc3dXOiZa1kjQVkN3c4d3c3eDf397e3t7e3t/DeZ2dnZ+ipqWlo6WjoqOinp+ZubSgo9Xg4ODkgC4jSj09R3dwoqXY3t/f397d3d3d3d3e3+DYdoyMjI2NjY2NjY2NjY2NjYyNsamwoNre39/f3t7b1neFhne33uDe3t7f39/f3t7f397e3trFf5SUk5STkpCPjo6Ojo6OjY+HyqmmwtTg4ODgd8A4NVpxaEQyZX6X3N3e3t7d3d3d3d3e39/f19na2tvb2tnZ2dnZ2dnZ29jZ48O9zdve39/f3t3ayo335HOh4tzh3d/f39/e3t7f397e3t/e19nY2dja2Nra2tra2trY3Nrc382+19Ld3t3ikVUcT4aGg2JEmaun5t7d3d3d3d3d3d3e397e3d3e3szg393b29vb29zdzsvb38jD09ve39/f3tvbo0Y6NFa3gd3c3t/f39/e3t7f397e3t7d3dzc3cjP3uDh4eHh4d/d1c7f3dW61tLd3t3c1rnGeGhnX1o8jrGm3uDd3d3d3d3d3d3e397d3d3d3d7e3dzc3Nzc3Nzc3t3b4MrE1Nve39/d393VnztphZvGkeTh39/f39/f39/i4uHg5OHi4uLi4uHj4eLi4uHg4eLl5ODk3dW619bf397c3d3d1E0/NkNbs67i3tzc3d3d3d3d3d3e397d3d3d3d3d3d3c3Nzc3Nzc3tzc4crE09ve397fvp+dl52OfXOp2t7f39/f39/f39PGnLrG1NXW1tbW1dXV1tbW1tfY2Nfe193Q09W61tTg39/d3eHfvYtSknan3d7Y3Nzc3d3d3d3d3d3e397d3d3d3d3d3d3d3d3d3d3d3dzc4crF1dve393htrStuXpgPTva39/e39/f39/f39Kitpuo8vz+/v79/Pz8/f7///O//cS71bjvzNW62NTg4N/d3d/IeohcXYuBttnb3Nzc3d3d3d3d3d3e397d3d3d3d3d3d3d3d3d3d3d3d3d4srE1dvd3t/f29jDbDE9QzCYxNzd3t7e3t7e3s6jnpij9P3+/v79/Pz8/f7///G84tC3wrztyta62NXe3t3c3NzRwry4vLvCyNnd2tvc3d3d3d3d3d3d3t3d3d3d3d3d3d3d3d3d3d3d3d3d4MvB09fb3d3d3tjIwr3Avb3BzNjc3Nzc3Nzc3NLDj62+293c3d7e3Nzc3d3e3tzUy9rY19nZytS4373ExMXHycvKyMbGxcXFxcTExMTFxcfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHwta+4sTIycrLy8nHx8fGxsfHyMjIyMjIyMjIyMzMysrKycrJysnIx8bGxsbGx8jKy8rJx8fHw9+24/X3+fj49/f29fT08/P09fT19fTz9Pb29vb29vb19fX19fX19fX19fX19fX19fX29vb29vLB9fHy8vP08/Py8vLy8vP09PPy8vLy8vLy8vTy8fT39vTz9PX09PT09PT09PX29/b29fX19fK46efq7Oro5ubl5eXl5ebn5+Xm5ubl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXm5eTk5u2/6eXn5+jo6Ojo5+fn5+fn6Ojo6Ojo6Ojo6Ojo6Ojo6Obl5eXk5OTk5OTk5OXl5eXl5ebm6PC+0pOioJ2cm5mbmpmZmpjH0c/Pz8/Ozs3Nzc3Nzc3Ozs7Ozs7Ozs7Ozs7Ozs7Ozs3Nzc7P0uPByZeZmJmbmZeXl568u7y6uLm5ubaxu7i8u7u6ubi2sLa9u729u7m5uLS50tTT09PT09TT0ua8uamupaKXjIyNkJWXlpa7zs7Ozs7Oz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Q0uPDtq6knpiQj5GTkJCZsbGysbGysrS1h66rsLKytLS3t3qut7Ows7SztbOeztDR0dHS0tPS0ea/vKamnpqOwpypk5GPjpG9zs7Ozs7Oz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Q0uPDtKy2p6+XmaCshY2eurbAxrXGtri+ha6+tr+7tbPAv4e1wcW8w7u4ur6j0NHR0dHR0tLS0eW4uqSknZaV0qusipCOjZG8zc7Ozs7Ozs/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Q0uPDtaqvpsjDvb3MiIubuLbIv8fQtru/iKnGx8C4vMfTxIiyvr6yxcewubyk0s/Pz8/Q0NDQz+G6"}};
  var NAMES = { player: 'player-store', hired: 'hired-merchant' };
  // Window-relative areas, as shares of the full window (from console/rows.py and the colour layout):
  // title: top 8%; seller label (player store): x < 30%, y 22-40%; avatar: above the seller label.
  var AREAS = {
    player: { title: [0, 0, 1, 0.09], seller: [0, 0.22, 0.32, 0.40], avatar: [0.03, 0.10, 0.20, 0.32], rowsX: [0, 0.5] },
    hired: { title: [0, 0, 1, 0.10], seller: null, avatar: null, rowsX: [0, 0.5] } // owner is in the title
  };
  var ROWS = 6;
  var DET_THR = 0.5;          // NCC on the 320 px frame (laptop: 0.45 at 640 px, then a native re-check)
  var PRE_THR = 0.3;          // prescreen
  var ROW_SCORE = 0.25;       // icon AND text (laptop listing score; low so greyed sold rows count)
  var SCALES = [0.5, 0.56, 0.62, 0.69, 0.76, 0.84, 0.92, 1.0, 1.1, 1.2, 1.32, 1.45, 1.6, 1.76, 1.94];

  function b64bytes(s) {
    if (typeof atob === 'function') {
      var bin = atob(s), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }
  Object.keys(TPL).forEach(function (k) {
    var t = TPL[k], b = b64bytes(t.b64), f = new Float32Array(b.length);
    for (var i = 0; i < b.length; i++) f[i] = b[i];
    t.half = { w: t.w, h: t.h, d: f };
    delete t.b64;
  });

  // ---------------------------------------------------------------- grey images
  function grey(imageData, outW) {
    // area-average resize of RGBA ImageData to outW wide grey (Float32)
    var W = imageData.width, H = imageData.height, src = imageData.data;
    var outH = Math.max(1, Math.round(outW * H / W));
    var acc = new Float32Array(outW * outH), cnt = new Float32Array(outW * outH);
    var fx = outW / W, fy = outH / H;
    var step = Math.max(1, Math.floor(W / outW / 2)); // sample, do not read every pixel of a 4K frame
    for (var y = 0; y < H; y += step) {
      var oy = Math.min(outH - 1, (y * fy) | 0), row = y * W * 4, orow = oy * outW;
      for (var x = 0; x < W; x += step) {
        var i = row + x * 4, o = orow + Math.min(outW - 1, (x * fx) | 0);
        acc[o] += 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
        cnt[o]++;
      }
    }
    for (var j = 0; j < acc.length; j++) acc[j] = cnt[j] ? acc[j] / cnt[j] : 0;
    return { w: outW, h: outH, d: acc };
  }

  function resize(img, w, h) { // area-ish (box for shrink, bilinear for grow)
    var out = new Float32Array(w * h), sx = img.w / w, sy = img.h / h;
    for (var y = 0; y < h; y++) {
      var y0 = y * sy, y1 = y0 + sy;
      for (var x = 0; x < w; x++) {
        var x0 = x * sx, x1 = x0 + sx;
        if (sx <= 1 && sy <= 1) {
          var cx = Math.min(img.w - 1, x0 + sx / 2 - 0.5), cy = Math.min(img.h - 1, y0 + sy / 2 - 0.5);
          cx = Math.max(0, cx); cy = Math.max(0, cy);
          var ix = cx | 0, iy = cy | 0, ax = cx - ix, ay = cy - iy;
          var ix2 = Math.min(img.w - 1, ix + 1), iy2 = Math.min(img.h - 1, iy + 1);
          out[y * w + x] = (img.d[iy * img.w + ix] * (1 - ax) + img.d[iy * img.w + ix2] * ax) * (1 - ay) +
            (img.d[iy2 * img.w + ix] * (1 - ax) + img.d[iy2 * img.w + ix2] * ax) * ay;
        } else {
          var s = 0, n = 0;
          for (var yy = y0 | 0; yy < Math.min(img.h, Math.ceil(y1)); yy++)
            for (var xx = x0 | 0; xx < Math.min(img.w, Math.ceil(x1)); xx++) { s += img.d[yy * img.w + xx]; n++; }
          out[y * w + x] = n ? s / n : 0;
        }
      }
    }
    return { w: w, h: h, d: out };
  }

  function prepTpl(img) { // zero-mean template and its norm
    var n = img.w * img.h, m = 0, i;
    for (i = 0; i < n; i++) m += img.d[i];
    m /= n;
    var z = new Float32Array(n), ss = 0;
    for (i = 0; i < n; i++) { z[i] = img.d[i] - m; ss += z[i] * z[i]; }
    return { w: img.w, h: img.h, z: z, norm: Math.sqrt(ss) };
  }

  function integrals(img) {
    var W = img.w + 1, H = img.h + 1, s = new Float64Array(W * H), q = new Float64Array(W * H);
    for (var y = 1; y < H; y++) {
      var rs = 0, rq = 0;
      for (var x = 1; x < W; x++) {
        var v = img.d[(y - 1) * img.w + x - 1];
        rs += v; rq += v * v;
        s[y * W + x] = s[(y - 1) * W + x] + rs;
        q[y * W + x] = q[(y - 1) * W + x] + rq;
      }
    }
    return { W: W, s: s, q: q };
  }

  // best normalised cross-correlation of tpl in img, positions limited to [x0..x1] x [y0..y1]
  function ncc(img, ii, tpl, x0, y0, x1, y1, stride) {
    var best = { v: -2, x: -1, y: -1 }, n = tpl.w * tpl.h, W = ii.W;
    if (tpl.norm < 1e-3) return best;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(img.w - tpl.w, x1); y1 = Math.min(img.h - tpl.h, y1);
    stride = stride || 1;
    for (var y = y0; y <= y1; y += stride) {
      for (var x = x0; x <= x1; x += stride) {
        var a = y * W + x, b = y * W + x + tpl.w, c = (y + tpl.h) * W + x, d = (y + tpl.h) * W + x + tpl.w;
        var sum = ii.s[d] - ii.s[b] - ii.s[c] + ii.s[a], sq = ii.q[d] - ii.q[b] - ii.q[c] + ii.q[a];
        var varr = sq - sum * sum / n;
        if (varr < 1) continue;
        var dot = 0;
        for (var ty = 0; ty < tpl.h; ty++) {
          var io = (y + ty) * img.w + x, to = ty * tpl.w;
          for (var tx = 0; tx < tpl.w; tx++) dot += img.d[io + tx] * tpl.z[to + tx];
        }
        var v = dot / (Math.sqrt(varr) * tpl.norm);
        if (v > best.v) best = { v: v, x: x, y: y };
      }
    }
    return best;
  }

  var tplCache = {};
  function scaledTpl(k, s, level) { // level 1 = 320 px frame, 2 = 160 px frame
    var key = k + '|' + s + '|' + level;
    if (!tplCache[key]) {
      var h = TPL[k].half, w = Math.max(4, Math.round(h.w * s / level)), hh = Math.max(4, Math.round(h.h * s / level));
      tplCache[key] = prepTpl(resize(h, w, hh));
    }
    return tplCache[key];
  }

  // ---------------------------------------------------------------- pixels of the colour frame
  function hsvAt(data, i) {
    var r = data[i], g = data[i + 1], b = data[i + 2];
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return [mx, mx ? (mx - mn) * 255 / mx : 0];
  }
  function median(arr) {
    if (!arr.length) return 0;
    var a = Float64Array.from(arr).sort(); // numeric typed sort: the same value as a compare sort, several times faster
    return a[a.length >> 1];
  }
  function clampBox(b, W, H) {
    var x0 = Math.max(0, Math.round(b[0])), y0 = Math.max(0, Math.round(b[1]));
    var x1 = Math.min(W, Math.round(b[2])), y1 = Math.min(H, Math.round(b[3]));
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
  }
  function panelOk(imageData, box) {
    var b = clampBox(box, imageData.width, imageData.height);
    if (!b) return false;
    var vs = [], ss = [], d = imageData.data, W = imageData.width;
    var st = Math.max(1, Math.floor((b[2] - b[0]) / 60));
    for (var y = b[1]; y < b[3]; y += st) for (var x = b[0]; x < b[2]; x += st) {
      var hv = hsvAt(d, (y * W + x) * 4); vs.push(hv[0]); ss.push(hv[1]);
    }
    return median(vs) >= 170 && median(ss) <= 60;
  }
  function greyAt(d, W, x, y) {
    var i = (y * W + x) * 4;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  // laptop listing_score for one band, sampled at template (640-space) resolution; u = frame px per template px
  function rowScore(imageData, bx, by0, by1, u) {
    var d = imageData.data, W = imageData.width, H = imageData.height;
    var hT = (by1 - by0) / u, m = Math.floor(hT / 5), ys = [];
    for (var t = m; t < hT - m; t++) { var yy = Math.round(by0 + t * u); if (yy >= 0 && yy < H) ys.push(yy); }
    if (!ys.length) return 0;
    function px(tx, yy) { var xx = Math.round(bx + tx * u); return xx >= 0 && xx < W ? greyAt(d, W, xx, yy) : 0; }
    var icon = [], tx;
    ys.forEach(function (yy) { for (tx = 3; tx < 23; tx++) icon.push(px(tx, yy)); });
    var med = median(icon), ic = 0;
    icon.forEach(function (v) { if (Math.abs(v - med) > 20) ic++; });
    var tc = 0, tn = 0;
    ys.forEach(function (yy) {
      var prev = px(26, yy);
      for (tx = 27; tx < 56; tx++) { var v = px(tx, yy); if (Math.abs(v - prev) > 18) tc++; tn++; prev = v; }
    });
    return Math.min((ic / icon.length) / 0.3, (tc / tn) / 0.1);
  }

  // The rows' separator lines: per frame line, the share of pixels far from the line's median (a separator is a thin
  // busy line between quiet ones). The grid (top, pitch) with the strongest separators near the expected place wins;
  // with no clear lines the expected place is used.
  var ROW_PITCH = 18.67, ROW_TOP = { player: 71.3, hired: 58 };
  function rowGrid(imageData, x0, x1, wy, u, top0) {
    var d = imageData.data, W = imageData.width, H = imageData.height, pitch = ROW_PITCH * u;
    var ya = Math.max(0, Math.floor(wy + (top0 - 12) * u)), yb = Math.min(H - 1, Math.ceil(wy + (top0 + 8 + ROWS * ROW_PITCH) * u));
    var st = Math.max(1, Math.floor((x1 - x0) / 120)), P = {};
    for (var yy = ya; yy <= yb; yy++) {
      var vals = [];
      for (var xx = Math.max(0, Math.round(x0)); xx < Math.min(W, x1); xx += st) vals.push(greyAt(d, W, xx, yy));
      var med = median(vals), c = 0;
      for (var i = 0; i < vals.length; i++) if (Math.abs(vals[i] - med) > 40) c++;
      P[yy] = vals.length ? c / vals.length : 0;
    }
    var g = Math.max(2, Math.round(u * 1.5));
    function line(yv) {
      var best = 0;
      for (var k = -1; k <= 1; k++) {
        var yq = Math.round(yv) + k;
        if (P[yq] === undefined || P[yq - g] === undefined || P[yq + g] === undefined) continue;
        best = Math.max(best, P[yq] - Math.max(P[yq - g], P[yq + g], P[yq - 2 * g] || 0, P[yq + 2 * g] || 0));
      }
      return best;
    }
    var best = { top: wy + top0 * u, pitch: pitch, score: 0 };
    for (var ps = 0.99; ps <= 1.011; ps += 0.01) {
      var p2 = pitch * ps;
      for (var t = wy + (top0 - 1.5) * u; t <= wy + (top0 + 1.5) * u; t += 1) {
        var sc = 0;
        for (var k2 = 1; k2 < ROWS; k2++) sc += line(t + k2 * p2);
        if (sc > best.score) best = { top: t, pitch: p2, score: sc };
      }
    }
    if (best.score < 0.5) best = { top: wy + top0 * u, pitch: pitch, score: best.score }; // under ~0.2 a line: guess
    return best;
  }

  // Share of an area in the slate blue of item tooltips (the laptop's _slate_mask: OpenCV hue 105-132, i.e. 210-264
  // degrees, saturation >= 55, value <= 175). A row under a tooltip is skipped in that frame: its picture is not the
  // row, and the reader can still read the price beside the tooltip, which passed the same row again and again.
  function tooltipShare(imageData, box) {
    var b = clampBox(box, imageData.width, imageData.height);
    if (!b) return 1;
    var d = imageData.data, W = imageData.width, st = Math.max(1, Math.floor((b[3] - b[1]) / 24)), n = 0, hit = 0;
    for (var y = b[1]; y < b[3]; y += st) for (var x = b[0]; x < b[2]; x += st) {
      var i = (y * W + x) * 4, r = d[i], g = d[i + 1], bl = d[i + 2], mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      n++;
      if (mx === 0 || mx > 175 || (mx - mn) * 255 / mx < 55 || mx !== bl) continue;
      var h = 240 + 60 * (r - g) / (mx - mn); // blue is the largest channel
      if (h >= 210 && h <= 264) hit++;
    }
    return n ? hit / n : 1;
  }

  // Whether a row is covered in this frame (the cursor, a tooltip), so it is skipped and passed in a later frame.
  // At a whole-number scale (the row box 262 game px wide) its text box must hold only the row's own colors, as
  // reader.js readExact checks (unsold paper 215 / ink 0, sold paper 244 / ink 187 / unfaded edge 215, underline
  // 250+); a row of any other paper (the selected row) is covered too. At other scales: the tooltip blue, in the text
  // box only (the icon and the frame above the first row tripped it, 2026-10-16: the first row was always skipped).
  var ROW_GAME_W = 262, TXT = [41, 203, 2];   // the text box: game px 41-202 of the row box, from its 3rd row
  // Whether the box (frame px) is a smooth stretch: 30%+ of its off-palette pixels are ramps, strictly between their
  // left and right (or upper and lower) neighbours by 6+ each way. A sold row's pale ink (187 on 244) blurred at 2x
  // gives steps of about 15 and 30, so the 15 each way of crispRow misses it. At a sharp whole k every pixel has a
  // twin beside it, so no ramps; a cover (the cursor, a tooltip) is flat colour with ramps at most along its edge.
  function smoothBox(imageData, x0, y0, x1, y1, k) {
    var W = imageData.width, H = imageData.height, d = imageData.data, off = 0, ramp = 0;
    var L = function (x, y) { var i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
    var btw = function (a, v, b) { return (a <= v - 6 && b >= v + 6) || (a >= v + 6 && b <= v - 6); };
    for (var y = Math.max(1, Math.round(y0)); y < Math.min(H - 1, Math.round(y1)); y++) for (var x = Math.max(1, Math.round(x0)); x < Math.min(W - 1, Math.round(x1)); x++) {
      var v = L(x, y);
      if (Math.abs(v - 215) <= 6 || Math.abs(v - 244) <= 6 || v <= 40 || v >= 250 || Math.abs(v - 187) <= 12) continue;
      off++;
      if (btw(L(x - 1, y), v, L(x + 1, y)) || btw(L(x, y - 1), v, L(x, y + 1))) ramp++;
    }
    return off >= 40 * k && ramp >= 0.3 * off;
  }
  function rowCovered(imageData, rbox) {
    var w = rbox[2] - rbox[0], k = Math.round(w / ROW_GAME_W);
    if (k >= 1 && k <= 4 && Math.abs(w - ROW_GAME_W * k) <= k) {
      var W = imageData.width, d = imageData.data, o = k >> 1, x0 = Math.round(rbox[0]), y0 = Math.round(rbox[1]);
      var gh = Math.floor((Math.round(rbox[3]) - y0) / k), vals = [], hist = {}, best = -1, paper = 0;
      for (var gy = TXT[2]; gy < gh - 2; gy++) for (var gx = TXT[0]; gx < TXT[1]; gx++) {
        var px = x0 + gx * k + o, py = y0 + gy * k + o;
        if (px >= W || py >= imageData.height) return true;
        var i = (py * W + px) * 4, v = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
        vals.push(v); hist[v] = (hist[v] || 0) + 1;
        if (hist[v] > best) { best = hist[v]; paper = v; }
      }
      var sold = Math.abs(paper - 244) <= 6;
      var clean = sold || Math.abs(paper - 215) <= 6;
      var ink = sold ? 187 : 0, inkTol = sold ? 12 : 40;
      for (var j = 0; clean && j < vals.length; j++) {
        var u = vals[j];
        if (Math.abs(u - paper) <= 6 || Math.abs(u - ink) <= inkTol || u >= 250 || (sold && Math.abs(u - 215) <= 6)) continue;
        clean = false;
      }
      if (clean) return false;
      // A smooth stretch at a whole k (a Retina Mac's 2x, R-DM76P) blurs every glyph edge off the palette: that row is
      // not covered, it is judged as at any other scale (the tooltip blue); reader.js undoes the stretch.
      if (k < 2 || !smoothBox(imageData, x0 + TXT[0] * k, y0 + TXT[2] * k, x0 + TXT[1] * k, Math.round(rbox[3]) - 2 * k, k)) return true;
    }
    var tw = w / ROW_GAME_W, th = (rbox[3] - rbox[1]) / 38;
    return tooltipShare(imageData, [rbox[0] + TXT[0] * tw, rbox[1] + 3 * th, rbox[0] + TXT[1] * tw, rbox[3] - 3 * th]) > 0.02;
  }

  // A row box at a whole-number scale k, put on the game pixel grid. The window is found on a 320 px grid (about 4
  // frame px) and its scale can come out a little off (0.98 for a 1x window with a tooltip over its empty slots), but
  // the exact reader needs the text box exactly: game px 41-202 are paper, 40 and 203 are frame. Tries shifts of up to
  // 4 px across and 2 down; returns the box (262k x 38k) where the most sampled rows have that edge, or null.
  function crispRow(imageData, rbox) {
    var w = rbox[2] - rbox[0], k = Math.round(w / ROW_GAME_W);
    if (k < 1 || k > 4 || Math.abs(w - ROW_GAME_W * k) > 0.04 * ROW_GAME_W * k) return null;
    var W = imageData.width, H = imageData.height, d = imageData.data, o = k >> 1;
    var L = function (x, y) { if (x < 0 || y < 0 || x >= W || y >= H) return -99; var i = (y * W + x) * 4; return Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); };
    // exact: the unsold row's frame (246) is 2 from sold paper (244)
    var paper = function (v) { return Math.abs(v - 215) <= 3 || Math.abs(v - 244) <= 1; };
    var x0r = Math.round(rbox[0]), y0r = Math.round(rbox[1]), best = null;
    // The edges are tested where they are, pixel against pixel: the frame's last pixel beside the paper's first. At a
    // sharp 2x, testing one pixel of each game pixel (its middle) passed a box 1 frame px off as well, half a game px off
    // the grid, and crispRow often took that one (nearer its first guess): every row's text then held frame and paper
    // blends, was called covered, and no row of a sharp 2x share read. At 1x these are the same pixels as before.
    // Down, 2 px at 1x, and 4 game px at 2x and over: a 2x window's first row came 3 game px off (rowGrid's lines at a
    // 2x share; rec2c at 2x: 664 for 670).
    var dyMax = k >= 2 ? 4 * k : 2;
    for (var dy = -dyMax; dy <= dyMax; dy++) for (var dx = -4; dx <= 4; dx++) {
      var x0 = x0r + dx, y0 = y0r + dy, ok = 0, n = 0;
      for (var gy = 2; gy <= 35; gy += 3) {
        var py = y0 + gy * k + o; n++;
        if (!paper(L(x0 + 41 * k - 1, py)) && paper(L(x0 + 41 * k, py)) && paper(L(x0 + 203 * k - 1, py)) && !paper(L(x0 + 203 * k, py))) ok++;
      }
      // the rows above and below the text box are not paper: game row 0 (the frame, or 253 over a sold row) against
      // row 2, and row 35 (paper; 215 on a sold row) against row 36 (the frame), pixel against pixel, in three columns
      // (most must hold; no glyph reaches rows 2 or 35). Game row 1 is paper on recorded rows, frame on drawn ones, so
      // it is not tested. The column edges hold at any height, so a box 3 game px too high passed them alone (rec2c at
      // 2x); a box whose top and bottom do not hold is not the row.
      // Only at 2x and over: at 1x the box is never off by a part of a game px, and a cover over those columns (the
      // cursor, a tooltip) failed the test there and dropped real rows to the old matcher (55 rows of the lossless
      // recordings changed, some to a wrong price), so 1x keeps its old check.
      if (k >= 2) {
        var tb = 0;
        for (var gx = 60; gx <= 180; gx += 60) {
          var px = x0 + gx * k + o;
          if (!paper(L(px, y0 + k - 1)) && paper(L(px, y0 + 2 * k)) && paper(L(px, y0 + 36 * k - 1)) && !paper(L(px, y0 + 36 * k))) tb++;
        }
        if (tb < 2) continue;
      } else if (paper(L(x0 + 120 * k + o, y0 + o)) || paper(L(x0 + 120 * k + o, y0 + 37 * k + o))) ok -= 2;
      var sc = ok / n - (Math.abs(dx) + Math.abs(dy)) * 0.001;
      if (!best || sc > best.sc) best = { sc: sc, x0: x0, y0: y0 };
    }
    if (!best || best.sc < 0.7) return null;
    // A smooth stretch near a whole number (1.98x: 1366x768 at 1.41x, stretched 1.41x again) can pass the edge test,
    // but it is not on a k grid: its rows would be cut 2x wide and placed 80 px apart instead of 79 (5 px off by the
    // 6th row). Its text has ramps (a pixel with a neighbour 15+ darker and one 15+ lighter) at most glyph edges.
    var off = 0, ramp = 0, bx0 = best.x0 + 41 * k, bx1 = best.x0 + 202 * k, by0 = best.y0 + 2 * k, by1 = best.y0 + 34 * k;
    for (var y = Math.max(1, by0); y < Math.min(H - 1, by1); y++) for (var x = Math.max(1, bx0); x < Math.min(W - 1, bx1); x++) {
      var v = L(x, y);
      if (Math.abs(v - 215) <= 6 || Math.abs(v - 244) <= 6 || v <= 40 || v >= 250 || Math.abs(v - 187) <= 12) continue;
      off++;
      var a = L(x - 1, y), b = L(x + 1, y), c = L(x, y - 1), e = L(x, y + 1);
      if (Math.min(a, b, c, e) <= v - 15 && Math.max(a, b, c, e) >= v + 15) ramp++;
    }
    if (off >= 40 * k && ramp >= 0.3 * off) return null;
    return [best.x0, best.y0, best.x0 + ROW_GAME_W * k, best.y0 + 38 * k];
  }

  // A row's picture for the reader. At a stretched scale (not a whole number) it is cut with a margin (16 game px across,
  // 12 down) and the margin is said in .pad [left, top, right, bottom] (frame px): the window's scale can be a few percent
  // off in a window share (a border and a title bar: a 2560x1440 game in a 2616x1478 frame), and the row grid then drifts
  // off the rows by up to 5 game px by the 6th row; reader.js finds the row inside the margin, and gives the old matcher
  // the plain cut.
  // The margin is measured from the box as it fits in the frame (nightly review of 2026-10-18: a box past the frame's
  // edge gave a negative margin, and the cut back to the box wrapped into the next pixel line: a garbled name crop).
  // .at: the cut's top left in the frame (reader.js undoes a browser's enlargement, whose pixel grid starts there).
  function rowImage(imageData, box, k) {
    if (!(k > 1.1 && Math.abs(k - Math.round(k)) > 0.03)) {
      var c = cut(imageData, box), b = c && clampBox(box, imageData.width, imageData.height);
      if (c) { try { c.at = [b[0], b[1]]; } catch (e) { /* frozen */ } }
      return c;
    }
    var W = imageData.width, H = imageData.height, px = Math.round(16 * k), py = Math.round(12 * k);
    var bx0 = Math.max(0, Math.round(box[0])), by0 = Math.max(0, Math.round(box[1])), bx1 = Math.min(W, Math.round(box[2])), by1 = Math.min(H, Math.round(box[3]));
    if (!(bx1 > bx0 && by1 > by0)) return null;
    var x0 = Math.max(0, bx0 - px), y0 = Math.max(0, by0 - py), x1 = Math.min(W, bx1 + px), y1 = Math.min(H, by1 + py);
    var im = cut(imageData, [x0, y0, x1, y1]); if (!im) return null;
    try { im.pad = [bx0 - x0, by0 - y0, x1 - bx1, y1 - by1]; im.at = [x0, y0]; } catch (e) { /* frozen */ }
    return im;
  }
  // A row's place for the reader: at, where its cut sits in the shared frame (reader.js keeps the game grid's phase in
  // frame terms from row to row), and enlarge, the browser's enlargement of the frame (R-RKFFH), which only goes when the
  // frame was drawn 1:1 (src: the frame's size and the part of it drawn; a frame drawn at another size, gameView's, is
  // resampled again, so there is no exact undo, and at is then in the drawn picture's px). The enlargement is the whole
  // frame's width over the screen's own pixels (screenPx): a pillarboxed frame is drawn without its black bars, and the
  // drawn picture's width gave too small a factor, so no row read (review of #295).
  // enlargeGame: the factor a 1080p game (its own x1.406) was drawn larger by, from the shop's game scale k (gameEnlarge);
  // for any frame, also one drawn at another size, where at is in the drawn picture's px (a Mac's 5120x2880 halved).
  function rowPlace(rim, screenPx, src, img, k) {
    var at = rim && rim.at, one = !src || (src.cut[2] === img.width && src.cut[3] === img.height);
    if (!at) return { enlarge: null, enlargeGame: null, at: null };
    var en = screenPx ? (src ? src.w : img.width) / screenPx : 1, eg = gameEnlarge(k);
    return { enlarge: en > 1.05 && one ? +en.toFixed(4) : null, enlargeGame: eg ? +eg.toFixed(4) : null, at: one && src ? [at[0] + src.cut[0], at[1] + src.cut[1]] : [at[0], at[1]] };
  }
  // A frame the size of the screen can still be enlarged: a 1080p game (1366x768 game px drawn x1.406) on a 2560x1440
  // screen with Windows' display scaling, or on a Mac, is drawn x1.333 again (R-4276X, R-2JLLH: game pixels 1.87x, one row
  // read in a session, the channel and the minimap not seen), and the screen's size gives no enlargement. The shop's game
  // scale tells: k over 1.406, when that is near a usual factor (within 3%: k comes from the template match, about 1% off,
  // and a window share's border adds 2%). It is a guess: a 2560x1440 game is a single x1.874 stretch, the same k (Grant's
  // rec1440), and reader.js keeps whichever way reads a row. 0 when none fits, or k is whole or under 1.5.
  var GAME_1080 = 1920 / 1366, ENLARGE_STEPS = [1.25, 4 / 3, 1.5, 5 / 3, 1.75, 2, 2.25, 2.5, 8 / 3, 3];
  function gameEnlarge(k) {
    if (!(k > 1.5) || Math.abs(k - Math.round(k)) <= 0.03) return 0;
    var e = k / GAME_1080, best = 0;
    ENLARGE_STEPS.forEach(function (s) { if (Math.abs(e / s - 1) <= 0.03 && (!best || Math.abs(e / s - 1) < Math.abs(e / best - 1))) best = s; });
    return best;
  }
  function cut(imageData, box) {
    var b = clampBox(box, imageData.width, imageData.height);
    if (!b) return null;
    var w = b[2] - b[0], h = b[3] - b[1], out = new Uint8ClampedArray(w * h * 4), src = imageData.data, W = imageData.width;
    for (var y = 0; y < h; y++) out.set(src.subarray(((b[1] + y) * W + b[0]) * 4, ((b[1] + y) * W + b[2]) * 4), y * w * 4);
    if (typeof ImageData === 'function') { try { return new ImageData(out, w, h); } catch (e) { /* node */ } }
    return { width: w, height: h, data: out, box: b };
  }

  // ---------------------------------------------------------------- the game's picture in the frame
  // The game draws 16:9 (1366x768 game px). On a screen of another shape (a MacBook is 16:10: 2560x1664) it is shown
  // with black bars, or stretched unevenly (x1 wide, x1.11 tall), and then every game pixel is taller than wide. From a
  // small thumbnail of the frame (ImageData, tw x th) for a frame of w x h: the box inside black bars (each bar at least
  // 2% of the frame, nearly all black), and the size to draw that box at so the game pixels are square again: a box
  // narrower than 1.65:1 is drawn 16:9 at its width, one wider than 1.85:1 16:9 at its height; between them (16:9,
  // or 16:9 with a window's title bar) as it is. Returns {sx, sy, sw, sh (frame px), w, h (the drawn size)}.
  function gameView(thumb, w, h) {
    var tw = thumb.width, th = thumb.height, d = thumb.data;
    var dark = function (x, y) { var i = (y * tw + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 14; };
    var rowBlack = function (y) { var n = 0; for (var x = 0; x < tw; x++) if (dark(x, y)) n++; return n >= 0.98 * tw; };
    var colBlack = function (x, y0, y1) { var n = 0; for (var y = y0; y < y1; y++) if (dark(x, y)) n++; return n >= 0.98 * (y1 - y0); };
    var y0 = 0, y1 = th; while (y0 < th && rowBlack(y0)) y0++; while (y1 > y0 && rowBlack(y1 - 1)) y1--;
    var x0 = 0, x1 = tw; while (x0 < tw && colBlack(x0, y0, y1)) x0++; while (x1 > x0 && colBlack(x1 - 1, y0, y1)) x1--;
    if (y0 < 0.02 * th) y0 = 0; if (th - y1 < 0.02 * th) y1 = th; if (x0 < 0.02 * tw) x0 = 0; if (tw - x1 < 0.02 * tw) x1 = tw;
    // mostly black: the whole frame. Not a letterbox, though: a full-width 16:9 picture between bars of equal height. A
    // game letterboxed on a portrait screen is 608 of 1920 lines, under a third (R-LEEB3: 1080x1920, the whole frame
    // squashed into 1080x608, no shop). Equal bars, as a letterbox has (review of #297: a 16:10 game with its top rows
    // dark, or a dark game with one bright band, is not one).
    var shape = y1 > y0 ? ((x1 - x0) * w / tw) / ((y1 - y0) * h / th) : 0;
    var picture = x0 === 0 && x1 === tw && y0 > 0 && y1 < th && Math.abs(y0 - (th - y1)) <= Math.max(1, 0.03 * th) && shape >= 1.7 && shape <= 1.86;
    if ((x1 - x0 < tw / 3 || y1 - y0 < th / 3) && !picture) { x0 = 0; x1 = tw; y0 = 0; y1 = th; picture = false; }
    var sx = Math.round(x0 * w / tw), sy = Math.round(y0 * h / th), sw = Math.round(x1 * w / tw) - sx, sh = Math.round(y1 * h / th) - sy;
    // the bars' edges on the thumbnail are a few frame lines out (1080x614 for a 1080x608 picture: 29 of 94 rows priced
    // in a replay, 55 of 92 when cut exactly): a picture between bars is exactly 16:9, about its middle
    if (picture) { var mid = sy + sh / 2; sh = Math.min(h, Math.round(sw * 9 / 16)); sy = Math.max(0, Math.min(h - sh, Math.round(mid - sh / 2))); }
    var a = sw / sh, ow = sw, oh = sh;
    if (a < 1.65) oh = Math.round(sw * 9 / 16); else if (a > 1.85) ow = Math.round(sh * 16 / 9);
    // A frame wider than 4K is the browser's own enlargement, not the window (reports R-J3J3V, R-WFWJC: a 2560x1440
    // screen gave 7680x4320 frames, the page's size cap, with resizeMode "none"): the game was drawn 3 times too big for
    // the minimap reader (scales up to 2.2) and each frame was 33 million pixels. It is drawn back down by a whole number,
    // the most that leaves it 2560 wide or more (7680 -> 2560: the window's own size; 5120 -> 2560), so the game's pixels
    // stay whole and never drop under 1x (review of bundle-326: a 6016x3384 desktop share with the game at 2x went to
    // 0.67x with a division by 3; it is halved now, to 3008).
    if (ow > 3840) { var n = Math.floor(ow / 2560); ow = Math.round(ow / n); oh = Math.round(oh / n); }
    return { sx: sx, sy: sy, sw: sw, sh: sh, w: ow, h: oh };
  }

  // ---------------------------------------------------------------- findShop
  // A shop's scale fits the frame's shape (sExp: the UI drawn 768 game px tall, stretched to the frame) or the same
  // game at 1920x1080, whose UI is drawn at 1x, 768 of its 1080 lines (R-Z3WRM, R-AAA7M, R-85XM8: a window the size of
  // the screen, the channel and minimap seen and no shop, its window at 0.71 of sExp). The 1x scale is exact (whole
  // game pixels), so its band is narrow, +-6%, and a match there must score UI_1080_MIN: a wider band (-20% / +15%)
  // took a pale desktop wallpaper at 0.62, score 0.52, for a shop (review of #292, recording rec2: a shop card with no
  // rows, and the reader tracked it instead of sweeping). Real 1x shops scored 0.62-0.74 in the recordings.
  var UI_1080 = 768 / 1080, UI_1080_MIN = 0.6;
  function shapeFits(s, sExp) { return (s >= sExp * 0.8 && s <= sExp * 1.15) || oneX(s, sExp); }
  function oneX(s, sExp) { return s >= sExp * UI_1080 * 0.94 && s <= sExp * UI_1080 * 1.06; }
  // sExp: the scale the frame's shape allows (findShop); only scales near it are searched (a full search of all 15
  // scales cost about 200 ms a frame with no shop open, QA 2026-10-16).
  function locate(imageData, hint, lock, sExp) {
    var g320 = grey(imageData, 320), g160 = resize(g320, 160, Math.max(1, Math.round(g320.h / 2)));
    var i320 = integrals(g320), i160 = null, cands = [];
    if (hint) { // tracking: the scale and place we locked on before
      cands.push({ k: hint.k, s: hint.s, x: hint.x, y: hint.y, r: 4 });
    } else {
      i160 = integrals(g160);
      var pre = [];
      Object.keys(TPL).forEach(function (k) {
        // with a scale lock (the session's window size), only the scales within -20% / +25% of it
        var list = lock && lock.scale ? SCALES.filter(function (s) { return s >= lock.scale * 0.8 && s <= lock.scale * 1.25; }) : SCALES;
        // and only those the frame's shape allows (sExp, or the same game at 1920x1080: shapeFits)
        // and the exact 1x scale itself (the coarse list's nearest are 0.69 and 0.76, 3% and 7% away from 0.711)
        if (sExp) {
          list = list.filter(function (s) { return shapeFits(s, sExp); });
          var s1 = Math.round(sExp * UI_1080 * 1000) / 1000;
          if (!lock || !lock.scale || (s1 >= lock.scale * 0.8 && s1 <= lock.scale * 1.25)) list = list.concat([s1]);
        }
        if (!list.length) list = [lock && lock.scale ? lock.scale : sExp];
        list.forEach(function (s) {
          var t = scaledTpl(k, s, 2);
          if (t.w >= g160.w || t.h >= g160.h) return;
          var r = ncc(g160, i160, t, 0, 0, g160.w, g160.h, 2);
          if (r.v >= PRE_THR) pre.push({ k: k, s: s, x: r.x * 2, y: r.y * 2, v: r.v, r: 4 });
        });
      });
      pre.sort(function (a, b) { return b.v - a.v; });
      // The best 3 overall, and the frame-shape band's best 3 as well. With the best 3 alone, the 1x scales of a Retina
      // 2x share's 2732x1592 frame (0.737, 0.76) took two of the three places, and the window's true 1.0 (fifth at the
      // coarse step) was never refined: the shop was found at 0.957, its rows 4% narrow and off the game pixel grid, so
      // a sharp 2x share read almost nothing. (The frame-shape band's best 3 alone, with only the 1x band's best, lost
      // rows of a 1x shop in a 1920x1080 game, rec3.)
      var inShape = function (p) { return !sExp || (p.s >= sExp * 0.8 && p.s <= sExp * 1.15); };
      cands = pre.slice(0, 3);
      pre.filter(inShape).slice(0, 3).forEach(function (p) { if (cands.indexOf(p) < 0) cands.push(p); });
    }
    // the best match that findShop would keep: each candidate is held to the frame-shape band and the 1x band's floor
    // here, not only the winner (review of bundle-334: a weak 1x match that scored a little higher hid a real shop)
    var keep = function (s, v) { return !sExp || (shapeFits(s, sExp) && !(oneX(s, sExp) && v < UI_1080_MIN)); };
    var best = null;
    cands.forEach(function (c) {
      var fine = hint ? [c.s] : [c.s * 0.96, c.s * 0.98, c.s, c.s * 1.02, c.s * 1.04];
      fine.forEach(function (s) {
        var s3 = Math.round(s * 1000) / 1000, t = scaledTpl(c.k, s3, 1);
        if (t.w >= g320.w || t.h >= g320.h) return;
        var r = ncc(g320, i320, t, c.x - c.r, c.y - c.r, c.x + c.r, c.y + c.r, 1);
        if (!keep(s3, r.v)) return;
        if (!best || r.v > best.v) best = { k: c.k, s: s3, x: r.x, y: r.y, v: r.v };
      });
    });
    return best;
  }

  function findShop(imageData, hint, lock) {
    var W = imageData.width, H = imageData.height;
    var sExp = 1.778 * H / W, m = locate(imageData, hint, lock, sExp);
    if (!m || m.v < DET_THR || m.x < 0) return null;
    // The game draws its UI 768 game px tall, scaled to the window, so in a shared window the shop's scale follows the
    // frame's shape: about 1.778 * H / W (1.0 for any 16:9 window; H may include a title bar). A "shop" far from that
    // is the Free Market's own art (QA 2026-10-16: 0.5-0.55 with no shop open, logged as shops and never sendable).
    if (!shapeFits(m.s, sExp)) return null;
    if (oneX(m.s, sExp) && m.v < UI_1080_MIN) return null;   // the 1x band: a surer match
    var t = TPL[m.k], f = W / 320;            // frame px per 320-space px
    var u = m.s * W / 640;                    // frame px per template (640-space) px
    var x = m.x * f, y = m.y * f, ww = t.fullW * u, wh = t.fullH * u;
    var lst = t.lst;
    if (!panelOk(imageData, [x + lst[0] * u, y + lst[1] * u, x + lst[2] * u, y + lst[3] * u])) return null;
    var A = AREAS[m.k], rel = function (a) { return a ? [x + a[0] * ww, y + a[1] * wh, x + a[2] * ww, y + a[3] * wh] : null; };
    // Row bands: 6 rows at a pitch of 18.67 template px (56 px at 1080p), placed on the row separator lines found in
    // the frame (fix 2026-10-16: equal sixths of the listing cut across two rows, so scrolled rows never matched).
    var grid = rowGrid(imageData, x + A.rowsX[0] * ww, x + A.rowsX[1] * ww, y, u, ROW_TOP[m.k]);
    var rows = [], anchor = null;   // the first row put on the game pixel grid: the rest are 40 game px apart from it
    for (var r = 0; r < ROWS; r++) {
      var a = grid.top + grid.pitch * r, b = a + grid.pitch;
      var sc = rowScore(imageData, x + lst[0] * u, a, b, u);
      var rbox = [x + A.rowsX[0] * ww, a + 1, x + A.rowsX[1] * ww, b - 1];
      if (anchor) { var dk = 40 * anchor.k * (r - anchor.r); rbox = [anchor.box[0], anchor.box[1] + dk, anchor.box[2], anchor.box[3] + dk]; }
      var crisp = crispRow(imageData, rbox);   // on the game pixel grid when the window is at a whole-number scale
      if (crisp) { rbox = crisp; if (!anchor) anchor = { r: r, box: crisp, k: Math.round((crisp[2] - crisp[0]) / ROW_GAME_W) }; }
      if (sc >= ROW_SCORE) rows.push({ index: r, box: rbox, score: Math.round(sc * 100) / 100, covered: rowCovered(imageData, rbox) });
    }
    return {
      // gameScale: screen px per game px (the game draws its UI 768 game px tall, 1366 wide at 16:9): 1 for a 1366x768
      // window, 1.406 for 1366x768 stretched to 1920x1080. uiScale stays 1.0 for any 16:9 window, stretched or not.
      kind: NAMES[m.k], score: Math.round(m.v * 1000) / 1000, uiScale: m.s, gameScale: Math.round(m.s * W / 1366 * 1000) / 1000,
      box: [x, y, x + ww, y + wh].map(Math.round), rows: rows,
      titleBox: rel(A.title), sellerBox: rel(A.seller), avatarBox: rel(A.avatar),
      hint: { k: m.k, s: m.s, x: m.x, y: m.y }
    };
  }

  // ---------------------------------------------------------------- frame-level cues (cheap)
  var MINIMAP = [0, 0, 0.25, 0.14];         // console/minimap.py REGION
  var CHANNEL = [0, 0, 0.25, 0.035];        // header strip of the minimap corner (opts.channelRegion overrides)
  function frac(W, H, r) { return [r[0] * W, r[1] * H, r[2] * W, r[3] * H]; }
  function stats(imageData, box, step) {
    var b = clampBox(box, imageData.width, imageData.height);
    if (!b) return { mean: 0, sd: 0, edge: 0 };
    var d = imageData.data, W = imageData.width, s = 0, q = 0, n = 0, e = 0, en = 0;
    for (var y = b[1]; y < b[3]; y += step) {
      var prev = null;
      for (var x = b[0]; x < b[2]; x += step) {
        var v = greyAt(d, W, x, y); s += v; q += v * v; n++;
        if (prev !== null) { if (Math.abs(v - prev) > 40) e++; en++; }
        prev = v;
      }
    }
    var mean = n ? s / n : 0;
    return { mean: mean, sd: n ? Math.sqrt(Math.max(0, q / n - mean * mean)) : 0, edge: en ? e / en : 0 };
  }
  function frameCues(imageData, opts) {
    var W = imageData.width, H = imageData.height, step = Math.max(1, Math.floor(W / 640));
    // Black or flat: judged on the game area only. A shared window's frame also holds the window's own title bar (white,
    // rows 1-30 of Chrome's 1368x800 frame of a 1366x768 window) and border, so over the whole frame a black loading
    // screen never looked black (sd about 47) and a channel change, a pick then a black screen, was never seen: the
    // status line kept the old channel (Grant, 2026-10-16). Leaving out the top 6% and a 1% edge takes the bar out.
    var all = stats(imageData, [Math.round(W * 0.01), Math.round(H * 0.06), Math.round(W * 0.99), Math.round(H * 0.99)], Math.max(2, Math.floor(W / 160)));
    var mm = stats(imageData, frac(W, H, (opts && opts.minimapRegion) || MINIMAP), step);
    var ch = stats(imageData, frac(W, H, (opts && opts.channelRegion) || CHANNEL), step);
    return {
      gameSeen: all.sd > 12,                          // not a black or flat frame
      hasMinimap: mm.edge > 0.04 && mm.sd > 25,       // a busy corner (map drawing and header text)
      hasChannel: ch.edge > 0.05 && ch.sd > 20        // text-like contrast in the channel strip
    };
  }

  // ---------------------------------------------------------------- hashes and visits
  function sig(imageData, box, gw, gh) { // small grey signature of an area
    var b = clampBox(box, imageData.width, imageData.height);
    if (!b) return null;
    var out = new Uint8Array(gw * gh), d = imageData.data, W = imageData.width;
    for (var y = 0; y < gh; y++) for (var x = 0; x < gw; x++) {
      var sx = b[0] + Math.floor((x + 0.5) * (b[2] - b[0]) / gw), sy = b[1] + Math.floor((y + 0.5) * (b[3] - b[1]) / gh);
      out[y * gw + x] = greyAt(d, W, sx, sy);
    }
    return out;
  }
  function sigDiff(a, b) {
    if (!a || !b || a.length !== b.length) return 255;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }
  function sigHash(a) { // FNV-1a over 4-bit quantised values
    var h = 2166136261;
    for (var i = 0; i < a.length; i++) { h ^= a[i] >> 4; h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // Scale-free, blurred, polarity-free signature of an area: each cell is the mean |pixel - area median| (a selection
  // highlight that only changes the background, or turns dark text light, changes little), divided by the area's
  // 95th percentile (brightness and contrast do not matter), then blurred over 3x3 cells.
  var ROW_GW = 96, ROW_GH = 16;
  var ROW_SAME = 0.12;      // one row against one row (block distance). Grant's recording 2b883001: an unchanged row
                            // 0.00-0.05 between frames; two different rows down to 0.19 (33,333 vs 44,444)
  var STACK_SAME = 0.16;    // mean over >= 2 aligned rows (the whole visible list against the visit's list); one row
                            // under the cursor or the selection highlight (about 0.7) in a stack of 6 still passes
  var VISIT_SAME = [0.015, 0.03]; // seller and title areas (mean cell distance; 2b883001: the same shop <= 0.01/0.02,
                                  // other shops >= 0.02 on the seller area)
  var REVISIT_MS = 60000;
  var RECENT_MAX = 16;      // ... and at most this many of them are kept to search (a busy minute in the Free Market)
  var LIST_MAX = 400;       // rows kept per visit (a shop shows at most a few dozen); about 8 KB each   // a shop re-opened within 60 s with the same seller/title is the same visit
  function normSig(imageData, box, gw, gh) {
    var b = clampBox(box, imageData.width, imageData.height);
    if (!b) return null;
    var d = imageData.data, W = imageData.width, bw = b[2] - b[0], bh = b[3] - b[1];
    var st = Math.max(1, Math.floor(Math.min(bw / gw, bh / gh) / 2)), vals = [], pts = [];
    for (var y = b[1]; y < b[3]; y += st) for (var x = b[0]; x < b[2]; x += st) {
      vals.push(greyAt(d, W, x, y));
      pts.push(Math.min(gh - 1, ((y - b[1]) * gh / bh) | 0) * gw + Math.min(gw - 1, ((x - b[0]) * gw / bw) | 0));
    }
    var med = median(vals), acc = new Float32Array(gw * gh), cnt = new Float32Array(gw * gh), i;
    for (i = 0; i < vals.length; i++) { acc[pts[i]] += Math.abs(vals[i] - med); cnt[pts[i]]++; }
    for (i = 0; i < acc.length; i++) acc[i] = cnt[i] ? acc[i] / cnt[i] : 0;
    var srt = Float64Array.from(acc).sort();
    var top = Math.max(8, srt[Math.floor(srt.length * 0.95)]), v = new Float32Array(acc.length);
    for (var yy = 0; yy < gh; yy++) for (var xx = 0; xx < gw; xx++) {
      var sum = 0, n = 0;
      for (var j = -1; j <= 1; j++) for (var k = -1; k <= 1; k++) {
        var y2 = yy + j, x2 = xx + k;
        if (y2 >= 0 && y2 < gh && x2 >= 0 && x2 < gw) { sum += acc[y2 * gw + x2]; n++; }
      }
      v[yy * gw + xx] = Math.min(1.5, sum / n / top);
    }
    var cols = new Float32Array(gw), rows = new Float32Array(gh), q = new Uint8Array(v.length);
    for (i = 0; i < v.length; i++) { cols[i % gw] += v[i]; rows[(i / gw) | 0] += v[i]; q[i] = Math.min(255, v[i] * 170); }
    return { w: gw, h: gh, v: v, q: q, cols: cols, rows: rows };
  }
  function bestShift(p, q, S) {
    var bd = 0, bv = Infinity;
    for (var d = -S; d <= S; d++) {
      var s = 0, n = 0;
      for (var i = Math.max(0, d); i < Math.min(p.length, p.length + d); i++) { s += Math.abs(p[i] - q[i - d]); n++; }
      s /= n;
      if (s < bv) { bv = s; bd = d; }
    }
    return bd;
  }
  // Row distance: align the two signatures by their column and row profiles (up to 6 and 3 cells), then the worst
  // 4x4-cell block. A different digit in the price gives a high block; noise and a 1-3 px shift do not.
  // Each cell's difference is taken once: a row's 4-cell sums, then 4 such rows added (was 16 differences per block,
  // the most of a frame's visit work; QA 2026-10-16, "ms a frame" 22 -> 36-49 ms as the shops of the last minute
  // added up). cap: the caller only needs to know whether the distance is above cap, so the search stops there and
  // returns a value above cap (the exact distance when it is at most cap).
  var RD_HS = new Float64Array(0);
  function rowDistance(a, b, cap) {
    if (!a || !b || a.w !== b.w || a.h !== b.h) return Infinity;
    var dx = bestShift(a.cols, b.cols, 6), dy = bestShift(a.rows, b.rows, 3), B = 4, mx = 0;
    var y0 = Math.max(0, dy), y1 = Math.min(a.h, a.h + dy), x0 = Math.max(0, dx), x1 = Math.min(a.w, a.w + dx);
    var nb = x1 - x0 - B + 1;
    if (nb <= 0 || y1 - y0 < B) return 0;
    var lim = cap == null ? Infinity : cap * B * B, w = a.w, av = a.v, bv = b.v;
    if (RD_HS.length < B * nb) RD_HS = new Float64Array(B * nb);
    var hs = RD_HS;   // the 4-cell sums of the last 4 rows (ring)
    for (var y = y0; y < y1; y++) {
      var slot = ((y - y0) % B) * nb, ra = y * w, rb = (y - dy) * w - dx, run = 0;
      for (var x = x0; x < x1; x++) {
        run += Math.abs(av[ra + x] - bv[rb + x]);
        if (x - x0 >= B) run -= Math.abs(av[ra + x - B] - bv[rb + x - B]);
        if (x - x0 >= B - 1) hs[slot + x - x0 - B + 1] = run;
      }
      if (y - y0 < B - 1) continue;
      for (var k = 0; k < nb; k++) {
        var s = hs[k] + hs[nb + k] + hs[2 * nb + k] + hs[3 * nb + k];
        if (s > mx) { mx = s; if (mx > lim) return mx / (B * B); }
      }
    }
    return mx / (B * B);
  }
  function areaDistance(a, b) { // mean cell distance at the best small shift (seller/title area)
    if (!a || !b || a.w !== b.w || a.h !== b.h) return Infinity;
    var dx = bestShift(a.cols, b.cols, 3), dy = bestShift(a.rows, b.rows, 2), s = 0, n = 0;
    for (var y = Math.max(0, dy); y < Math.min(a.h, a.h + dy); y++)
      for (var x = Math.max(0, dx); x < Math.min(a.w, a.w + dx); x++) { s += Math.abs(a.v[y * a.w + x] - b.v[(y - dy) * b.w + x - dx]); n++; }
    return n ? s / n : Infinity;
  }
  // Place the visible rows (band index -> signature) in the visit's known list. The list scrolls by whole rows, so
  // the whole stack is matched at one offset: rows that land on known places are not new; rows past the end are.
  // Returns the list places of the visible rows (null = new, place it at the end).
  function placeRows(list, vis) {
    var n = vis.length, best = null;
    if (list.length && n >= 2) {
      var minBand = vis[0].band, maxBand = vis[n - 1].band;
      for (var o = -maxBand; o <= list.length - 1 - minBand; o++) { // list place of band b = b + o
        var sum = 0, cnt = 0, i, at;
        for (i = 0; i < n; i++) { at = vis[i].band + o; if (at >= 0 && at < list.length) cnt++; }
        if (cnt < 2) continue;
        // an offset whose sum already passes STACK_SAME * cnt can never be taken: its search stops there
        var limit = STACK_SAME * cnt + 1e-9, over = false;
        for (i = 0; i < n && !over; i++) {
          at = vis[i].band + o;
          if (at < 0 || at >= list.length) continue;
          var left = limit - sum, d = Math.min(1, rowDistance(vis[i].sig, list[at], Math.min(1, Math.max(0, left))));
          sum += d;
          if (sum > limit) over = true;
        }
        if (over) continue;
        if (cnt >= 2 && sum / cnt <= STACK_SAME && (!best || sum / cnt < best.mean - 0.02 || (sum / cnt <= best.mean + 0.02 && cnt > best.cnt)))
          best = { o: o, mean: sum / cnt, cnt: cnt };
      }
    }
    return vis.map(function (r) {
      if (best) {
        var at = r.band + best.o;
        if (at >= 0 && at < list.length) return at;
      }
      for (var k = 0; k < list.length; k++) if (rowDistance(r.sig, list[k], ROW_SAME) <= ROW_SAME) return k;
      return null;
    });
  }

  // ---------------------------------------------------------------- live capture
  function start(stream, onShop, opts) {
    opts = opts || {};
    // 8 frames a second (was 3; Grant, 2026-10-16: "It's slower than the other guy"). A frame whose shop window did
    // not change costs about a tenth of a full one (see `same` below), so most frames are cheap.
    var fps = Math.min(10, opts.fps || 8), minGap = 1000 / fps, last = 0, stopped = false;
    var SWEEP_MS = 250;        // the full search for a shop window while none is open (was once a second)
    var SAME_MAX_MS = opts.sameMaxMs || 1000;    // an unchanged window is still fully processed at least once a second
    var shopSig = null, shopSigBox = null, fullAt = -Infinity, lastCues = null, skipped = 0, lastMap = null;
    clearTimeout(frameDrop); dropFrames();   // a new session's own frames
    // The window's scale, kept once a window with 3 or more rows was found (the replays of 2026-10-16 found a box half
    // the real window's size, 362 px instead of 738, whose rows all failed). Sweeps then search near this scale; every
    // 4th sweep searches all scales, and a window at another scale is taken only when 3 sweeps in a row find it there
    // (the player changed the UI scale).
    var lock = null, offLock = 0, sweeps = 0;
    function lockedFind(img) {
      sweeps++;
      var shop = findShop(img, null, lock && sweeps % 4 ? lock : null);
      if (!shop) return null;
      if (lock && Math.abs(shop.uiScale / lock.scale - 1) > 0.2) {
        if (++offLock < 3) return null;
        lock = null;
      }
      offLock = 0;
      if (shop.rows.length >= 3) lock = { scale: shop.uiScale };
      return shop;
    }
    var track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
    if (!track) throw new Error('MesoLiveCapture: the stream has no video track');
    var canvas = null, ctx = null, hint = null, misses = 0, sweepAt = 0;
    var visit = null, recent = [], nVisits = 0, cleanup = [];
    // what the visit logic keeps, for the long-session check (tests/perf/livereader-capture-longrun.cjs)
    if (opts.debug) opts.debug.state = function () { return { recent: recent.length, list: visit ? visit.list.length : 0, lists: recent.reduce(function (a, o) { return a + o.list.length; }, 0) }; };
    // Diagnostics for the live log: the frame size, the shared surface, the window's UI scale, and the speed over the
    // last 5 seconds (frames processed a second, ms a frame: grab + find + rows; ms of the shop-window search alone).
    var surface = null;
    try { surface = (track.getSettings && track.getSettings().displaySurface) || null; } catch (e) { surface = null; }
    var perf = [], lastScale = null, lastGame = null, lastBox = null, findMs = 0;
    var clock = function () { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); };
    function diag(img) {
      var t = clock();
      while (perf.length && t - perf[0].t > 5000) perf.shift();
      var n = perf.length, tot = 0, fnd = 0, same = 0;
      for (var i = 0; i < n; i++) { tot += perf[i].ms; fnd += perf[i].find; same += perf[i].same ? 1 : 0; }
      var span = n > 1 ? (perf[n - 1].t - perf[0].t) / 1000 : 0;
      return {
        w: img.width, h: img.height, srcW: lastSrc ? lastSrc.w : null, srcH: lastSrc ? lastSrc.h : null, cut: lastSrc ? lastSrc.cut : null, surface: surface, scale: lastScale, gameScale: lastGame, shopW: lastBox ? lastBox[2] - lastBox[0] : null,
        fps: span > 0 ? Math.round((n - 1) / span * 10) / 10 : null,
        msFrame: n ? Math.round(tot / n) : null, msFind: n ? Math.round(fnd / n) : null,
        sameShare: n ? Math.round(same / n * 100) / 100 : null,   // frames skipped because the open shop window did not change
        frames: { track: frames.track.slice(), paint: frames.paint.slice(), clock: frames.clock.slice() }   // [read, new pictures] (countFrame)
      };
    }

    // The game's picture in the shared frame, on square game pixels (view(): see gameView). Looked at again every 2 s
    // on a 192 px wide thumbnail, so black bars that appear or a window resize are followed.
    var view = null, viewAt = -Infinity, viewSrc = null, tcanvas = null, tctx = null;
    function viewOf(source, w, h) {
      var t = clock();
      if (view && viewSrc === w + 'x' + h && t - viewAt < 2000) return view;
      viewAt = t; viewSrc = w + 'x' + h;
      try {
        var tw = 192, th = Math.max(8, Math.round(192 * h / w));
        if (!tcanvas || tcanvas.width !== tw || tcanvas.height !== th) {
          tcanvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(tw, th) : Object.assign(document.createElement('canvas'), { width: tw, height: th });
          tctx = tcanvas.getContext('2d', { willReadFrequently: true });
        }
        tctx.drawImage(source, 0, 0, tw, th);
        view = gameView(tctx.getImageData(0, 0, tw, th), w, h);
      } catch (e) { view = { sx: 0, sy: 0, sw: w, sh: h, w: w, h: h }; }
      return view;
    }
    // How much the browser enlarged the picture past the screen: a shared window is never bigger than the screen's own
    // pixels (screen x devicePixelRatio), so a frame wider than that was stretched by the browser (R-YGKB8: 2560 on a 1920
    // screen; R-8HMCG: 3840). 1 when not, or not known (opts.screenPx for tests).
    function screenPxOf() { return opts.screenPx || (typeof screen !== 'undefined' && screen.width ? screen.width * ((typeof devicePixelRatio === 'number' && devicePixelRatio) || 1) : 0); }
    function enlargeOf(img) {
      var px = screenPxOf();
      var e = px ? img.width / px : 1;
      return e > 1.05 ? e : 1;
    }
    var lastSrc = null;   // the source frame's size and the box of it drawn (diag: a report shows a squash, R-DRBGA)
    function grab(source, w0, h0) {
      var v = viewOf(source, w0, h0), w = v.w, h = v.h;
      lastSrc = { w: w0, h: h0, cut: [v.sx, v.sy, v.sw, v.sh] };
      if (!canvas || canvas.width !== w || canvas.height !== h) {
        canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
        ctx = canvas.getContext('2d', { willReadFrequently: true });
      }
      ctx.drawImage(source, v.sx, v.sy, v.sw, v.sh, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h);
    }

    function handle(img, ts) {
      // An open shop window that looks the same as in the last fully processed frame (a 48x40 grey sample of its box)
      // gives nothing new: say "shop open" and stop here.
      if (hint && shopSig && ts - fullAt < SAME_MAX_MS) {
        var now0 = sig(img, shopSigBox, 48, 40);
        if (sigDiff(now0, shopSig) < 1.5) {
          skipped++;
          if (opts.onFrame) {
            try { opts.onFrame({ ts: ts, gameSeen: lastCues ? lastCues.gameSeen : true, hasMinimap: lastCues ? lastCues.hasMinimap : null, hasChannel: lastCues ? lastCues.hasChannel : null, shopOpen: true, same: true, diag: diag(img) }); } catch (e) { /* page code */ }
          }
          return;
        }
      }
      fullAt = ts;
      var cues = frameCues(img, opts), shop = null, f0 = clock();
      lastCues = cues;
      try {
        if (hint) shop = findShop(img, hint);
        // full sweep at most about once a second while no shop is open (it costs the most)
        if (!shop && (hint || ts - sweepAt >= SWEEP_MS)) { sweepAt = ts; shop = lockedFind(img); }
      } catch (e) { shop = null; if (opts.onError) opts.onError(e); }
      findMs = clock() - f0;
      hint = shop ? shop.hint : null;
      if (shop) { lastScale = shop.uiScale; lastGame = shop.gameScale; lastBox = shop.box; shopSigBox = shop.box; shopSig = sig(img, shop.box, 48, 40); } else shopSig = null;
      // the channel number from the CHANGE CHANNEL menu (channelreader.js, loaded by live.js; null until a menu is read)
      var ch = null, CR = root.MesoChannelReader;
      if (CR) { try { opts.channelWatch = opts.channelWatch || CR.watcher(); ch = opts.channelWatch.frame(img, ts, cues.gameSeen); } catch (e) { ch = null; } }
      // the map name from the minimap title (mapreader.js, loaded by live.js; read at most once a second, shown after 3 equal reads)
      var mp = null, MR = root.MesoMapReader, en = enlargeOf(img);
      if (MR && MR.loaded()) { try { opts.mapWatch = opts.mapWatch || MR.watcher(); mp = opts.mapWatch.frame(img, ts, cues.gameSeen, { enlarge: en }); } catch (e) { mp = null; } }
      lastMap = mp;   // the report's frames carry the map read with them
      if (opts.onFrame) {
        try { opts.onFrame({ ts: ts, gameSeen: cues.gameSeen, hasMinimap: cues.hasMinimap, hasChannel: cues.hasChannel, shopOpen: !!shop, channel: ch && ch.channel, channelStale: !!(ch && ch.stale), channelWhy: ch ? ch.why : null, channelLooks: ch ? ch.looks : null, map: mp && mp.map, room: mp && mp.room, mapWhy: mp && mp.why, mapScale: mp ? mp.scale : null, mapScaleOf: mp ? mp.scaleOf : null, mapEnlarge: en > 1 ? +en.toFixed(3) : null, diag: diag(img) }); } catch (e) { /* page code */ }
      }
      if (!shop) { if (visit && ++misses && ts - visit.last > 3000) visit = null; return; }   // closed for 3 s: the visit ends
      misses = 0;
      // (b) the visit: the current or a recent visit (up to 60 s ago) is the same visit when the visible rows fit its
      // list, or when the seller and title areas look the same. So a re-opened shop does not count its rows again.
      var key = normSig(img, shop.sellerBox || shop.titleBox, 48, 8), tkey = normSig(img, shop.titleBox, 64, 6);
      var vis = shop.rows.filter(function (r) { return !r.covered; }).map(function (r) { return { band: r.index, box: r.box, sig: normSig(img, r.box, ROW_GW, ROW_GH) }; })
        .filter(function (r) { return r.sig; });
      var placed = null;   // the last placeRows of sameVisit, used again for the visit it found (the same list)
      var sameVisit = function (o) {
        if (o.kind !== shop.kind) return false;
        if (o.list.length && vis.length) {
          var pl = placeRows(o.list, vis);
          placed = { o: o, len: o.list.length, res: pl };
          var fit = pl.filter(function (x) { return x !== null; }).length;
          if (fit >= Math.min(2, vis.length) && fit * 2 >= vis.length) return true;
        }
        return areaDistance(key, o.key) <= VISIT_SAME[0] && areaDistance(tkey, o.tkey) <= VISIT_SAME[1];
      };
      if (!visit || !sameVisit(visit)) {
        var cur = visit;   // just found not the same: not tried again
        visit = null;
        for (var v = recent.length - 1; v >= 0 && !visit; v--) if (recent[v] !== cur && ts - recent[v].last <= REVISIT_MS && sameVisit(recent[v])) visit = recent[v];
        if (!visit) {
          nVisits++;
          visit = { id: Date.now().toString(36) + '-' + nVisits, kind: shop.kind, key: key, tkey: tkey, list: [], last: ts };
          recent.push(visit);
        }
      }
      visit.last = ts;
      recent = recent.filter(function (o) { return ts - o.last <= REVISIT_MS; });
      // at most RECENT_MAX visits are searched for a re-opened shop: the ones seen last
      if (recent.length > RECENT_MAX) recent = recent.sort(function (a, b) { return a.last - b.last; }).slice(-RECENT_MAX);
      // (a) the rows: each row is passed once per visit (placeRows: whole-stack alignment, then row by row).
      var places = placed && placed.o === visit && placed.len === visit.list.length ? placed.res : placeRows(visit.list, vis), fresh = [];
      vis.forEach(function (r, i) {
        if (places[i] !== null) return;
        if (visit.list.length >= LIST_MAX) return; // a runaway visit stops growing (memory); a new visit starts fresh
        visit.list.push(r.sig);
        places[i] = visit.list.length - 1;
        // scale: the reader's expected scale for this row (the window's UI scale at this frame width), a search hint
        var rim = rowImage(img, r.box, shop.gameScale);
        fresh.push(Object.assign({ index: visit.list.length - 1, image: rim, pad: rim && rim.pad || null, hash: sigHash(r.sig.q), scale: shop.uiScale * img.width / 1920, gameScale: shop.gameScale }, rowPlace(rim, screenPxOf(), lastSrc, img, shop.gameScale)));
      });
      if (!fresh.length) return;
      // view: the list places of the rows on screen, top to bottom (live.js orders the shop by them: a row found while
      // scrolling up goes above the rows below it, not at the end of the list)
      var view = [];
      places.forEach(function (p) { if (p !== null && view.indexOf(p) < 0) view.push(p); });
      var W = img.width, H = img.height;
      onShop({
        visitId: visit.id, ts: ts, rows: fresh, view: view, kind: shop.kind,
        sellerImage: shop.sellerBox ? cut(img, shop.sellerBox) : null,
        titleImage: cut(img, shop.titleBox),
        avatarImage: shop.avatarBox ? cut(img, shop.avatarBox) : null,
        minimapImage: cues.hasMinimap ? cut(img, frac(W, H, opts.minimapRegion || MINIMAP)) : null,
        channelImage: cues.hasChannel ? cut(img, frac(W, H, opts.channelRegion || CHANNEL)) : null,
        // the channel comes with the frames (channelreader.js); the map is the last confirmed minimap title (mapreader.js)
        channel: null, map: mp && mp.map, room: mp && mp.room,
        frameWidth: W, frameHeight: H
      });
    }

    function due(ts) { if (ts - last < minGap) return false; last = ts; return true; }
    // Frames read, by what woke the reader (track: MediaStreamTrackProcessor, Chrome; paint: the <video>'s paint ticks;
    // clock: the clock while the paint ticks had stopped, the page covered), and how many were a new picture (a 48x27
    // grey sample differs from the last frame's by more than 2 somewhere). R-PV9JA (Firefox, after #294): no menu-like
    // frame in 25 minutes, and the report's 6 frames, 1 s apart, were one picture 4 times and another twice: whether a
    // covered page's <video> gives new pictures at all is not known. The report says it (upload.js "state: frames").
    var frames = { track: [0, 0], paint: [0, 0], clock: [0, 0] }, lastPic = null;
    function countFrame(img, how) {
      var W = img.width, H = img.height, d = img.data, pic = new Uint8Array(48 * 27), fresh = !lastPic;
      for (var y = 0; y < 27; y++) for (var x = 0; x < 48; x++) {
        var i = ((((y + 0.5) * H / 27) | 0) * W + (((x + 0.5) * W / 48) | 0)) * 4, k = y * 48 + x;
        pic[k] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        if (!fresh && Math.abs(pic[k] - lastPic[k]) > 2) fresh = true;
      }
      lastPic = pic; frames[how][0]++; if (fresh) frames[how][1]++;
    }
    function processFrame(source, w, h, how) {
      var t0 = clock(), s0 = skipped, ts = Date.now();
      findMs = 0;
      var img = grab(source, w, h);
      countFrame(img, how || 'track');
      handle(img, ts);
      keepFrame(img, ts);
      perf.push({ t: t0, ms: clock() - t0, find: findMs, same: skipped > s0 });
    }
    // The last FRAME_RING frames the reader saw, one a second at most, for "Report a problem" (the player ticks a box to
    // send them; nothing leaves the page otherwise). Kept as ImageBitmaps (on the graphics side, not in the page's memory)
    // where the browser has them, else as the frame's pixels; with the time and the map read then. Dropped at stop.
    var ringAt = -Infinity;
    function keepFrame(img, ts) {
      // only when the page asks (opts.keepFrames: FEATURES.reportFrames on; review of bundle-329: one full frame a second,
      // 6 kept, up to ~50 MB at 1080p, were kept in every session, on phones too)
      var keep = typeof opts.keepFrames === 'function' ? !!opts.keepFrames() : !!opts.keepFrames;   // a function: asked on every frame
      if (!keep || ts - ringAt < FRAME_EVERY_MS || !img) return;
      ringAt = ts;
      var entry = { ts: ts, w: img.width, h: img.height, map: lastMap ? lastMap.map : null, mapWhy: lastMap ? lastMap.why : null, image: null };
      var put = function (image) {
        if (stopped) { try { image && image.close && image.close(); } catch (e) { /* gone */ } return; }
        entry.image = image; frameRing.push(entry);
        while (frameRing.length > FRAME_RING) { var old = frameRing.shift(); try { old.image && old.image.close && old.image.close(); } catch (e) { /* gone */ } }
      };
      try {
        if (typeof createImageBitmap === 'function' && canvas) createImageBitmap(canvas).then(put, function () { put(img); });
        else put(img);
      } catch (e) { put(img); }
    }
    // At Stop the report's frames are kept FRAME_KEEP_MS more, not dropped (nightly review of 2026-10-19, A4: a report made
    // just after Stop had no frames, the moment a player reports most); a new reading drops them at once (start, above).
    cleanup.push(function () { clearTimeout(frameDrop); frameDrop = setTimeout(dropFrames, FRAME_KEEP_MS); if (frameDrop && frameDrop.unref) frameDrop.unref(); });   // (node: not held open by it)

    if (typeof MediaStreamTrackProcessor === 'function' && !opts.forceVideo) {
      var reader = new MediaStreamTrackProcessor({ track: track }).readable.getReader();
      (function pump() {
        reader.read().then(function (res) {
          if (stopped || res.done) { if (res.value) res.value.close(); return; }
          var frame = res.value, now = performance.now();
          try { if (due(now)) processFrame(frame, frame.displayWidth, frame.displayHeight, 'track'); }
          finally { frame.close(); }
          pump();
        }).catch(function (e) { if (!stopped && opts.onError) opts.onError(e); });
      })();
      cleanup.push(function () { try { reader.cancel(); } catch (e) { /* closed */ } });
    } else {
      var video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.srcObject = stream;
      video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px';
      document.body.appendChild(video);
      video.play().catch(function (e) { if (opts.onError) opts.onError(e); });
      var tickAt = -Infinity;   // the last paint-driven tick
      var tick = function () {
        if (stopped) return;
        tickAt = performance.now();
        if (video.videoWidth && due(tickAt)) processFrame(video, video.videoWidth, video.videoHeight, 'paint');
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
      };
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
      // Firefox has no MediaStreamTrackProcessor, and its paint callbacks stop while the page cannot be seen: with the
      // browser maximized, a click into the game covers it (reports R-WVUQ8, R-2AN8P: "no menu-like frame", minimap
      // seen, shops 0; every such Firefox report had the browser maximized, and the two that read a channel did not).
      // So the CHANGE CHANNEL menu and the shops, only open while the game is in front, were never read. A clock keeps
      // reading when the paint ticks stop: a worker's timer (a hidden page's own timers wait 1 s or more), else the page's.
      var wake = function () {
        if (stopped) return;
        var now = performance.now();
        if (now - tickAt > 2 * minGap && video.videoWidth && due(now)) processFrame(video, video.videoWidth, video.videoHeight, 'clock');
      };
      var ticker = null, tickerUrl = null, timer = null;
      try {
        tickerUrl = URL.createObjectURL(new Blob(['setInterval(function () { postMessage(0); }, ' + Math.round(minGap) + ');'], { type: 'text/javascript' }));
        ticker = new Worker(tickerUrl);
        ticker.onmessage = wake;
      } catch (e) {
        if (tickerUrl) { try { URL.revokeObjectURL(tickerUrl); } catch (x) { /* gone */ } }
        ticker = null; tickerUrl = null; timer = setInterval(wake, minGap);
      }
      cleanup.push(function () {
        if (ticker) ticker.terminate();
        if (tickerUrl) URL.revokeObjectURL(tickerUrl);
        if (timer) clearInterval(timer);
        video.pause(); video.srcObject = null; video.remove();
      });
    }

    return function stop() {
      stopped = true;
      cleanup.forEach(function (f) { f(); });
    };
  }

  // frames(): the report's frames, oldest first ({ts, w, h, map, mapWhy, image}); empty when not reading
  var FRAME_RING = 6, FRAME_EVERY_MS = 1000, FRAME_KEEP_MS = 10 * 60 * 1000, frameRing = [], frameDrop = null;
  function dropFrames() { frameDrop = null; while (frameRing.length) { var e = frameRing.shift(); try { e.image && e.image.close && e.image.close(); } catch (x) { /* gone */ } } }
  var api = { start: start, frames: function () { return frameRing.slice(); }, FRAME_RING: FRAME_RING, FRAME_KEEP_MS: FRAME_KEEP_MS, dropFrames: function () { clearTimeout(frameDrop); dropFrames(); }, _dropFrames: dropFrames, _frameDropAt: function () { return !!frameDrop; }, _gameView: gameView, findShop: function (img) { return findShop(img); }, _findShop: findShop, _locate: locate, _crispRow: function (img, b) { return crispRow(img, b); }, _rowCovered: rowCovered, _rowPlace: rowPlace, rowImage: rowImage, frameCues: frameCues, _tooltipShare: tooltipShare, _sig: sig, _sigDiff: sigDiff, _normSig: normSig, _rowDistance: rowDistance, _areaDistance: areaDistance, _placeRows: placeRows };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MesoLiveCapture = api;
})(typeof window !== 'undefined' ? window : globalThis);
